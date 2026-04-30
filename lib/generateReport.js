import Anthropic from '@anthropic-ai/sdk';
import nodemailer from 'nodemailer';
import { google } from 'googleapis';

const MASTER_SHEET_ID = '1YJK05oU_12wX0qK-vTqJJfaS8eVI7JMzdGP0gVso1G4';
const MASTER_TAB = '👩‍🎓 All Data';
const CHECKIN_TAB = 'CheckinForm';
const REPORT_TO = 'support@admissions.partners';
const REPORT_CC = 'ryan@sapientacademy.com';

function getServiceAuth() {
  return new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

async function fetchStudentData(sheets, studentSheetId, studentName) {
  const [overviewRes, projectsRes, transcriptRes] = await Promise.all([
    sheets.spreadsheets.values.get({
      spreadsheetId: studentSheetId,
      range: '🔎 Overview!B2:D20',
      valueRenderOption: 'UNFORMATTED_VALUE',
    }),
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

  const ov = overviewRes.data.values || [];
  const name   = ov[0]?.[0] || studentName;
  const year   = ov[2]?.[1] || '';
  const major  = ov[4]?.[1] || '';
  const sat    = ov[15]?.[1] || '';
  const numAPs = ov[16]?.[1] || '';

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
        percentComplete: r[4] || '',
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
  const studentRows = rows.filter(r => r[1] === studentName).slice(-3);
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
  const row = rows.find(r => r[0] === studentName);
  return row?.[49] || '';
}

function buildHtmlEmail(reportMarkdown, studentName) {
  let html = reportMarkdown
    .replace(/^## (.+)$/gm, (_, h) =>
      `<hr style="border:none;border-top:1px solid #ccc;margin:24px 0 16px;">
       <h1 style="font-family:'Figtree',sans-serif;font-size:18px;color:#763f21;font-weight:bold;font-style:italic;text-transform:uppercase;margin:0 0 8px;">${h}</h1>`)
    .replace(/^### (.+)$/gm, (_, h) =>
      `<h2 style="font-family:'Figtree',sans-serif;font-size:15px;color:#2f5034;font-style:italic;font-weight:normal;margin:12px 0 4px;">${h}</h2>`)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/^- (.+)$/gm, '<li style="margin:4px 0;">$1</li>')
    .replace(/(<li[^>]*>.*<\/li>\n?)+/g, m => `<ul style="margin:8px 0;padding-left:20px;">${m}</ul>`)
    .replace(/\n\n(?!<)/g, '</p><p style="margin:8px 0;">')
    .replace(/\n(?!<)/g, '<br>');

  return `<!DOCTYPE html>
<html>
<head>
  <link href="https://fonts.googleapis.com/css2?family=Figtree:ital,wght@0,400;0,700;1,400;1,700&family=Bitter:ital,wght@0,400;0,700;1,400&display=swap" rel="stylesheet">
</head>
<body style="font-family:'Bitter',Georgia,serif;font-size:12pt;color:#000000;line-height:1.15;max-width:680px;margin:0 auto;padding:24px;">
  <p style="margin:0 0 4px;font-family:'Figtree',sans-serif;font-size:13px;color:#888;">Weekly Check-In Report</p>
  <h1 style="font-family:'Figtree',sans-serif;font-size:22px;color:#763f21;margin:0 0 4px;">${studentName}</h1>
  <p style="font-family:'Figtree',sans-serif;font-size:12px;color:#aaa;margin:0 0 24px;">${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</p>
  <p style="margin:8px 0;">${html}</p>
</body>
</html>`;
}

function buildPlainText(reportMarkdown, studentName) {
  return `Weekly Check-In Report: ${studentName}
${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
${'─'.repeat(60)}

${reportMarkdown
  .replace(/^## /gm, '\n')
  .replace(/^### /gm, '\n')
  .replace(/\*\*/g, '')}`;
}

async function sendReportEmail(studentName, reportMarkdown) {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });

  await transporter.sendMail({
    from: process.env.SMTP_USER,
    to: REPORT_TO,
    cc: REPORT_CC,
    subject: `Weekly Report: ${studentName} — ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`,
    text: buildPlainText(reportMarkdown, studentName),
    html: buildHtmlEmail(reportMarkdown, studentName),
  });
}

const SYSTEM_PROMPT = `You are a private admissions counselor writing a weekly check-in report for a student. Write in professional but warm prose. Use the student's correct pronouns throughout.

CRITICAL RULES:
- Never infer, fill in gaps, or hallucinate. Use only the imported data as your source of truth.
- If something is missing or unclear, omit it rather than speculating.
- Do not recommend academic tutoring services (outside scope). SAT tutoring is acceptable.
- Be concise — maximum 2 sentences per bullet point, 1–2 bullets per section.
- Each section should be skimmable in under 30 seconds.
- Reference the intended major when making academic observations, UNLESS it is "TBD".
- Our students apply to top schools: any grade below an A- warrants attention.

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

await sendReportEmail(studentData.name, reportText);

// Write to WrittenReports tab in master sheet
try {
  const writeAuth = getServiceAuth();
  const writeSheets = google.sheets({ version: 'v4', auth: writeAuth });
  await writeSheets.spreadsheets.values.append({
    spreadsheetId: MASTER_SHEET_ID,
    range: 'WrittenReports!A:D',
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [[
        new Date().toISOString(),  // A: Timestamp
        studentData.name,          // B: Student
        reportText,                // C: Report
        false,                     // D: Sent (checkbox — Google Sheets renders FALSE as unchecked)
      ]],
    },
  });
} catch (sheetErr) {
  console.error('Failed to write report to WrittenReports sheet:', sheetErr);
}

console.log('Report generated and sent for', studentName);

  } catch (err) {
    console.error('triggerReportGeneration error:', err);
  }
}