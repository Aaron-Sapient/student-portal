import Anthropic from '@anthropic-ai/sdk';
import nodemailer from 'nodemailer';
import { google } from 'googleapis';
import { DateTime } from 'luxon';
import { emailBaseUrl } from './baseUrl.js';
import { readMode, logShadow } from './readFlags.js';
import { getSupabaseClient, STUDENT_PROFILES } from './supabase.js';

const MASTER_SHEET_ID = '1YJK05oU_12wX0qK-vTqJJfaS8eVI7JMzdGP0gVso1G4';
const MASTER_TAB = '👩‍🎓 All Data';
const CHECKIN_TAB = 'CheckinForm';
const NOTIFY_TO = 'support@admissions.partners';

function getServiceAuth() {
  return new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

// Sheets returns 0.5 for a cell formatted "50%" under UNFORMATTED_VALUE.
// Without this, the prompt rendered "0.5% complete" for any percent-formatted cell.
function normalizePercent(raw) {
  if (raw === '' || raw == null) return '';
  if (typeof raw === 'number') {
    if (raw > 0 && raw <= 1) return Math.round(raw * 100);
    return Math.round(raw);
  }
  const s = String(raw).trim().replace(/%$/, '');
  const n = parseFloat(s);
  if (Number.isFinite(n)) {
    if (n > 0 && n <= 1) return Math.round(n * 100);
    return Math.round(n);
  }
  return raw;
}

// ── overview_profile domain (name / grade / major / SAT / #APs) ──────────────
// The reader generateReport uses for the Claude prompt. Lives behind
// READ_SUPABASE_OVERVIEW_PROFILE; Sheets reads UNFORMATTED over 🔎 Overview!B2:D20
// (values in col C / index 1). The mirror (mirrorStudentHub.cjs) stores the same
// UNFORMATTED values as text, so the shapes reconstruct identically.
async function readOverviewFromSheets(sheets, studentSheetId, studentName) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: studentSheetId,
    range: '🔎 Overview!B2:D20',
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const ov = res.data.values || [];
  return {
    name:   ov[0]?.[0] || studentName,
    year:   ov[2]?.[1] || '',
    major:  ov[4]?.[1] || '',
    sat:    ov[15]?.[1] || '',
    numAPs: ov[16]?.[1] || '',
  };
}

async function readOverviewFromSupabase(studentSheetId, studentName) {
  const sb = getSupabaseClient();
  const { data, error } = await sb
    .from(STUDENT_PROFILES)
    .select('display_name, current_year, major, sat, num_aps')
    .eq('student_sheet_id', studentSheetId)
    .maybeSingle();
  if (error) throw error; // let the dispatcher fall back to Sheets
  return {
    name:   (data?.display_name ?? '') || studentName,
    year:   data?.current_year ?? '',
    major:  data?.major ?? '',
    sat:    data?.sat ?? '',
    numAPs: data?.num_aps ?? '',
  };
}

async function readOverviewProfile(sheets, studentSheetId, studentName) {
  const mode = readMode('overview_profile');
  if (mode === 'on') {
    try {
      return await readOverviewFromSupabase(studentSheetId, studentName);
    } catch {
      return readOverviewFromSheets(sheets, studentSheetId, studentName);
    }
  }
  const sheetsVal = await readOverviewFromSheets(sheets, studentSheetId, studentName);
  if (mode === 'shadow') {
    try {
      const supaVal = await readOverviewFromSupabase(studentSheetId, studentName);
      const diffs = ['name', 'year', 'major', 'sat', 'numAPs']
        .filter((k) => String(sheetsVal[k]) !== String(supaVal[k]))
        .map((k) => `${k}: ${JSON.stringify(sheetsVal[k])} != ${JSON.stringify(supaVal[k])}`);
      logShadow('overview_profile', studentName, diffs);
    } catch (e) {
      logShadow('overview_profile', studentName, [`supabase error: ${e.message}`]);
    }
  }
  return sheetsVal;
}

async function fetchStudentData(sheets, studentSheetId, studentName) {
  const [overview, projectsRes, transcriptRes] = await Promise.all([
    readOverviewProfile(sheets, studentSheetId, studentName),
    sheets.spreadsheets.values.get({
      spreadsheetId: studentSheetId,
      range: '🏆 Comps & Projects!E:L',
      valueRenderOption: 'UNFORMATTED_VALUE',
    }),
    sheets.spreadsheets.values.get({
      spreadsheetId: studentSheetId,
      range: '🎓 Transcript!AA5:AD15',
      valueRenderOption: 'UNFORMATTED_VALUE',
    }),
  ]);

  const { name, year, major, sat, numAPs } = overview;

  const today = new Date();
  const projectRows = (projectsRes.data.values || []).slice(1);
  const activeProjects = projectRows
    .filter(r => {
      const status = r[6] || '';
      const isActive = status === '🟢' || status === '✅';
      if (!isActive) return false;
      const rawDate = r[2];
      if (!rawDate) return true;
      const endDate = typeof rawDate === 'number'
        ? new Date((rawDate - 25569) * 86400 * 1000)
        : new Date(rawDate);
      return isNaN(endDate) || endDate >= new Date(today.getFullYear(), 0, 1);
    })
    .map(r => {
      const fmtDate = (raw) => {
        if (!raw) return '';
        const d = typeof raw === 'number'
          ? new Date((raw - 25569) * 86400 * 1000)
          : new Date(raw);
        return isNaN(d) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      };
      return {
        activity: r[0] || '',
        startDate: fmtDate(r[1]),
        endDate: fmtDate(r[2]),
        deadline: fmtDate(r[3]),
        percentComplete: normalizePercent(r[4]),
        status: r[6] || '',
        details: r[7] || '',
      };
    })
    .filter(p => p.activity);

  const summerCourses = (transcriptRes.data.values || [])
    .filter(r => r[0])
    .map(r => ({ course: r[0] || '', institution: r[1] || '', grade: r[2] || '', year: r[3] || '' }));

  return { name, year, major, sat, numAPs, activeProjects, summerCourses };
}

async function fetchCheckinHistory(sheets, studentName) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: MASTER_SHEET_ID,
    range: `${CHECKIN_TAB}!A:L`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });

  const rows = res.data.values || [];
  // Trim-insensitive: check-in rows are written from the form with the student's
  // Overview name, which can carry a trailing space the master roster lacks
  // (seen live on "Aasrith Dwarampudi "). An exact === would silently find no
  // history and abort the whole report.
  const target = String(studentName ?? '').trim();
  const studentRows = rows.filter(r => String(r[1] ?? '').trim() === target).slice(-3);
  if (!studentRows.length) return null;

  const latest = studentRows[studentRows.length - 1];
  const previous = studentRows.slice(0, -1);

  return {
    current: {
      grades: latest[2] || '',
      testsDeadlines: latest[3] || '',
      taskUpdates: latest[4] || '',
      concernCategory: latest[5] || '',
      concernText: latest[6] || '',
      selfRating: latest[7] || '',
    },
    gradeHistory: previous.map(r => ({ timestamp: r[0] || '', grades: r[2] || '' })),
  };
}

async function fetchGender(sheets, studentName) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: MASTER_SHEET_ID,
    range: `${MASTER_TAB}!A:AX`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const rows = res.data.values || [];
  const target = String(studentName ?? '').trim();
  const row = rows.find(r => String(r[0] ?? '').trim() === target);
  return row?.[49] || '';
}

// Plain-text notification — no report content, just a heads-up that a new draft
// is waiting in /developer for review. Claude is not involved.
async function sendReadyForReviewEmail(studentName, dateLabel) {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });

  const reviewUrl = `${emailBaseUrl()}/developer`;
  await transporter.sendMail({
    from: process.env.SMTP_USER,
    to: NOTIFY_TO,
    subject: `${studentName}'s ${dateLabel} written report is ready for review`,
    text: `A new written report was just generated and is waiting for review at ${reviewUrl}.`,
  });
}

// Splits the Claude markdown report on `## ` headings into the four canonical
// buckets the dashboard exposes. Forgiving: if Claude emits both `## STRATEGY`
// and `## RECOMMENDATIONS` as separate sections (the prompt is slightly
// ambiguous), both bodies merge into the strategy bucket.
function parseReportSections(markdown) {
  const sections = { onTarget: '', needsAttention: '', strategy: '', parentRequests: '' };
  const parts = String(markdown || '').split(/\n## /);
  // First chunk may have a leading "## " (no preceding newline) or stray preamble.
  // Normalize so we treat each chunk as `Heading\nbody...`.
  parts[0] = parts[0].replace(/^## /, '');

  for (const part of parts) {
    if (!part.trim()) continue;
    const newlineIdx = part.indexOf('\n');
    const headingLine = (newlineIdx === -1 ? part : part.slice(0, newlineIdx)).trim();
    const body = (newlineIdx === -1 ? '' : part.slice(newlineIdx + 1)).trim();
    const heading = headingLine.toUpperCase();

    let bucket = null;
    if (heading.startsWith('ON TARGET')) bucket = 'onTarget';
    else if (heading.startsWith('NEEDS ATTENTION')) bucket = 'needsAttention';
    else if (heading.startsWith('STRATEGY') || heading.startsWith('RECOMMENDATIONS')) bucket = 'strategy';
    else if (heading.startsWith('PARENT REQUESTS')) bucket = 'parentRequests';

    if (bucket) {
      sections[bucket] = sections[bucket]
        ? `${sections[bucket]}\n\n## ${headingLine}\n${body}`
        : body;
    }
  }
  return sections;
}

const SYSTEM_PROMPT = `You are a private admissions counselor writing a weekly check-in report for a student. Write in professional but warm prose. Use the student's correct pronouns throughout.

CRITICAL RULES:
- Never infer, fill in gaps, or hallucinate. Use only the imported data as your source of truth.
- If something is missing or unclear, omit it rather than speculating.
- Do not recommend academic tutoring services (outside scope). SAT tutoring is acceptable.
- Be concise — maximum 2 sentences per bullet point, 1–2 bullets per section.
- Each section should be skimmable in under 30 seconds.
- Reference the intended major when making academic observations, UNLESS it is "TBD".
- NEVER-NEGATIVE LANGUAGE (CRITICAL). Parents read every word of this report and pay Sapient for results. EVERY observation — including everything under NEEDS ATTENTION — must be growth-oriented and forward-looking, never punitive or alarmist. State the fact plainly, then pair it with the concrete next action. Reframe any shortfall as room to grow:
  - "needs improvement in Chemistry" → "room to grow in Chemistry"
  - "weakness in math" / "math is weak" → "math is the next area to build"
  - "grade is slipping/sliding/declining" → "the B in Chemistry is one to keep an eye on this term"
  - "a critical concern" / "significantly impacts his chances" → "worth a focused check-in"
  Do NOT use these words in any line: concern, critical, slipping, sliding, declining, struggling, weak/weakness, failing, below target, below standard, non-negotiable, stabilize immediately, urgent.
- Treat any grade below an A- as worth a GENTLE mention in NEEDS ATTENTION, phrased as growth (e.g. "the B in Chemistry is worth keeping an eye on"). Name the grade; never editorialize about what it costs the student. Do NOT justify it with school selectivity, admissions thresholds/benchmarks, what "top schools"/"top programs"/"competitive applicants" expect, or what "we expect"/"target." Never mention thresholds, targets, benchmarks, or the competitiveness of any school tier.
- NEVER IMPLY THE PROGRAM ISN'T DELIVERING (CRITICAL). Never describe a Sapient-assigned project, competition, essay, or research task — anything the team runs — as "behind," "significantly behind," "stalled," "stuck," "overdue," "missed its deadline," or by a bare low "% complete" that reads as failure. A project that is early or past a soft deadline is framed ONLY as the next concrete action and the chance ahead — e.g. NOT "Solo Research is 0% complete, past its May 1 deadline" but "Solo Research is the priority to launch next — let's get the first section underway this week." Describe in-progress and submitted work as momentum and chances created, never as results that are missing or late.
- SUBMISSION ≠ ACCEPTANCE. A completed or finalized application/submission to a summer program, competition, or any external program is NOT the same as being accepted, admitted, selected, or winning. Unless the imported data explicitly states the student was accepted/admitted/selected, describe the work as a "submission," "application sent," or "application complete" — never as an acceptance, admission, placement, or win. When in doubt, omit. This matters: misstating a submission as an acceptance and sending it to parents creates a serious problem we cannot recover from gracefully.

REWRITE EXAMPLES (rewrite every shortfall in this spirit — same fact, growth framing):
- BAD: "AP Spanish (F) is a critical concern that significantly impacts his college readiness." → GOOD: "AP Spanish is the subject to focus on next term — worth a quick plan for how to bring it up."
- BAD: "Math is sliding; the C- is below the A- threshold top schools expect." → GOOD: "Calculus is the next area to build — keeping an eye on it through finals will help."
- BAD: "Solo Research is 0% complete and past its May 1 deadline." → GOOD: "Solo Research is the priority to launch next — let's get the first section underway this week."
- BAD: "Writing remains below the A- standard we expect." → GOOD: "Writing is an area with room to grow; a focused pass on the next essay will move it."

FORMAT YOUR RESPONSE using these markers exactly:
- Use ## for main section headings (ON TARGET, NEEDS ATTENTION, STRATEGY, RECOMMENDATIONS, PARENT REQUESTS)
- Use ### for sub-headings within sections (e.g., ### Short-Term, ### Long-Term)
- Use - for bullet points
- Use **bold** for emphasis
- Do not use any other markdown

SECTIONS TO INCLUDE:
## ON TARGET
Positive feedback on strengths. Reference academic performance relative to intended major. Reference active projects close to completion.

## NEEDS ATTENTION
Flag weaknesses or grade slips, especially in major-relevant subjects. Reference projects under 50% complete with deadlines under two weeks away.

## STRATEGY & Recommendations
### Short-Term
1–2 short digestible priorities for the next 1–2 weeks.
### Long-Term
1–2 longer-horizon priorities.

## PARENT REQUESTS
1–2 easy, concrete steps for parents. Reference the report content.`;

export async function triggerReportGeneration(studentName, studentSheetId) {
  try {
    const authClient = getServiceAuth();
    const sheets = google.sheets({ version: 'v4', auth: authClient });

    const [studentData, checkinHistory, gender] = await Promise.all([
      fetchStudentData(sheets, studentSheetId, studentName),
      fetchCheckinHistory(sheets, studentName),
      fetchGender(sheets, studentName),
    ]);

    if (!checkinHistory) {
      console.error('generateReport: no checkin history for', studentName);
      return;
    }

    const pronouns = gender?.toLowerCase().includes('f') ? { sub: 'she', obj: 'her', pos: 'her' }
      : gender?.toLowerCase().includes('m') ? { sub: 'he', obj: 'him', pos: 'his' }
      : { sub: 'they', obj: 'them', pos: 'their' };

    const projectsText = studentData.activeProjects.length
      ? studentData.activeProjects.map(p =>
          `- ${p.activity} | Start: ${p.startDate} | End: ${p.endDate} | Deadline: ${p.deadline} | ${p.percentComplete}% complete | Status: ${p.status} | ${p.details}`
        ).join('\n')
      : 'No active projects on record.';

    const summerText = studentData.summerCourses.length
      ? studentData.summerCourses.map(c =>
          `- ${c.course} at ${c.institution} (${c.year}) — Grade: ${c.grade}`
        ).join('\n')
      : 'No summer coursework on record.';

    const gradeHistoryText = checkinHistory.gradeHistory.length
      ? checkinHistory.gradeHistory.map((h, i) =>
          `Submission ${i + 1} (${h.timestamp ? new Date(h.timestamp).toLocaleDateString() : 'unknown'}): ${h.grades}`
        ).join('\n')
      : 'No previous grade submissions on record.';

    const today = new Date().toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    });

    const contextBlock = `
TODAY'S DATE: ${today}

STUDENT OVERVIEW
Name: ${studentData.name}
Gender: ${gender} (use pronouns: ${pronouns.sub}/${pronouns.obj}/${pronouns.pos})
Current Year: ${studentData.year}
Intended Major/Path: ${studentData.major || 'TBD'}
SAT Score: ${studentData.sat || 'Not on record'}
Number of APs: ${studentData.numAPs || 'Not on record'}

ACTIVE PROJECTS & ACTIVITIES
${projectsText}

SUMMER COURSEWORK
${summerText}

THIS WEEK'S CHECK-IN
Grades (current): ${checkinHistory.current.grades}
Tests & Deadlines: ${checkinHistory.current.testsDeadlines}
Task Updates: ${checkinHistory.current.taskUpdates}
Questions/Concerns Category: ${checkinHistory.current.concernCategory}
Questions/Concerns Detail: ${checkinHistory.current.concernText}
Academic Self-Rating: ${checkinHistory.current.selfRating}/10

GRADE HISTORY (previous submissions)
${gradeHistoryText}
`.trim();

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: contextBlock }],
    });

    const reportText = response.content[0]?.text || '';
    if (!reportText) throw new Error('Claude returned empty report');

    const sections = parseReportSections(reportText);

    // Write parsed sections to the new WrittenReports tab (7 cols).
    try {
      await sheets.spreadsheets.values.append({
        spreadsheetId: MASTER_SHEET_ID,
        range: 'WrittenReports!A:G',
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: {
          values: [[
            new Date().toISOString(),    // A: Date
            String(studentData.name ?? '').trim(), // B: Student (trimmed — the upload matches master col A exactly)
            sections.onTarget,           // C: On Target
            sections.needsAttention,     // D: Needs Attention
            sections.strategy,           // E: Strategy & Recommendations
            sections.parentRequests,     // F: Parent Requests
            false,                       // G: Status (unchecked)
          ]],
        },
      });
    } catch (sheetErr) {
      console.error('Failed to write report to WrittenReports sheet:', sheetErr);
    }

    // Fire the lightweight notification ping. Failure here must not abort the sheet write
    // (which already happened above) — wrap defensively.
    try {
      const dateLabel = DateTime.now().setZone('America/Los_Angeles').toFormat('LLL d');
      await sendReadyForReviewEmail(studentData.name, dateLabel);
    } catch (mailErr) {
      console.error('Failed to send ready-for-review notification:', mailErr);
    }

    console.log('Report generated and staged for review:', studentName);

  } catch (err) {
    console.error('triggerReportGeneration error:', err);
  }
}