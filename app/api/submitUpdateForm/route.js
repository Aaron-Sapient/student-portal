import { auth } from '@clerk/nextjs/server';
import { google } from 'googleapis';
import { DateTime } from 'luxon';
import Anthropic from '@anthropic-ai/sdk';
import { triggerReportGeneration } from '@/lib/generateReport';
import { listBlocksForBooking, isDateBlocked } from '@/lib/blocks';
import { getProjectRows } from '@/lib/projects';
import { makeApprovalToken } from '@/lib/checkinApproval';
import { sendRyanMeetingRequestEmail } from '@/lib/checkinEmails';
import { getSeniorBySheetId, createCheckinGrant } from '@/lib/seniors';

const MASTER_SHEET_ID = '1YJK05oU_12wX0qK-vTqJJfaS8eVI7JMzdGP0gVso1G4';
const MASTER_TAB = '👩‍🎓 All Data';
const CHECKIN_TAB = 'CheckinForm';
const CHECKINS_TAB = '✅ Check-Ins';

function getServiceAuth() {
  return new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

// Convert letter grade to GPA points
function gradeToPoints(grade) {
  const map = {
    'A+': 4.0, 'A': 4.0, 'A-': 3.7,
    'B+': 3.3, 'B': 3.0, 'B-': 2.7,
    'C+': 2.3, 'C': 2.0, 'C-': 1.7,
    'D+': 1.3, 'D': 1.0, 'D-': 0.7,
    'F': 0.0,
  };
  return map[grade] ?? null;
}

// Build a grade snapshot string: "English: A+, Biology: B-"
function buildGradeSnapshot(classes, grades) {
  return classes
    .map((cls, i) => grades[i] ? `${cls.name}: ${grades[i]}` : null)
    .filter(Boolean)
    .join(', ');
}

// Parse a grade snapshot string back into an object { className: grade }
function parseGradeSnapshot(snapshot) {
  if (!snapshot) return {};
  return Object.fromEntries(
    snapshot.split(',').map(s => {
      const [name, grade] = s.split(':').map(x => x.trim());
      return [name, grade];
    })
  );
}

// Detect grade drops between two snapshots
function detectGradeDrops(previousSnapshot, currentSnapshot) {
  const drops = [];
  for (const [cls, currentGrade] of Object.entries(currentSnapshot)) {
    const prevGrade = previousSnapshot[cls];
    if (!prevGrade || !currentGrade) continue;
    const prevPoints = gradeToPoints(prevGrade);
    const currPoints = gradeToPoints(currentGrade);
    if (prevPoints !== null && currPoints !== null && currPoints < prevPoints) {
      drops.push({
        class: cls,
        from: prevGrade,
        to: currentGrade,
        drop: +(prevPoints - currPoints).toFixed(1),
        isSignificant: (prevPoints - currPoints) >= 1.0, // one full letter or more
        isDanger: currPoints <= 1.0, // D or F
      });
    }
  }
  return drops;
}

// Calculate unweighted GPA from current grade snapshot
function calculateGPA(snapshot) {
  const points = Object.values(snapshot)
    .map(g => gradeToPoints(g))
    .filter(p => p !== null);
  if (!points.length) return null;
  return +(points.reduce((a, b) => a + b, 0) / points.length).toFixed(2);
}

export async function POST(request) {
  const { sessionClaims } = await auth();
  const email = sessionClaims?.email;
  if (!email) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const body = await request.json();
    const {
      grades,           // [{ rowOffset, grade }]
      studentSheetId,
      gradesRange,
      studentRowIndex,
      studentName,
      classes,          // [{ name, grade, rowOffset }] — need names for snapshot
      testsAndDeadlines,
      actionItemStatuses, // [{ task, status }]
      questionsCategory,
      questionsText,
      selfRating,
      responsePreference,
    } = body;

    // Seniors do a record-only weekly check-in: it's the deterministic prerequisite
    // that unlocks their booking for the week (no Claude eval, no token, no Ryan
    // approval email, no report). We still write grades + the AY timestamp + the
    // CheckinForm row, then return early before the urgency-evaluation machinery.
    const isSenior = body.senior === true;

    const authClient = getServiceAuth();
    const sheets = google.sheets({ version: 'v4', auth: authClient });

    // ── 1. Write grades back to student Transcript tab ──────────────────────
    if (grades?.length && gradesRange && studentSheetId) {
      const rangeMatch = gradesRange.match(/^(.+)!([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
      if (rangeMatch) {
        const [, tab, col, startRow] = rangeMatch;
        const startRowNum = parseInt(startRow);
        const gradeData = grades.map(({ rowOffset, grade }) => ({
          range: `${tab}!${col}${startRowNum + rowOffset}`,
          values: [[grade || '']],
        }));
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: studentSheetId,
          requestBody: { valueInputOption: 'USER_ENTERED', data: gradeData },
        });
      }
    }

    const now = new Date().toISOString();

    // ── 2. Stamp the check-in timestamp(s) in 👩‍🎓 All Data ──────────────────
    // AY = Ryan/primary check-in. SENIORS are a unified program with ONE weekly
    // check-in instead of separate Ryan + Aaron tracks, so we also stamp BA
    // (Aaron's column). The Friday reminder checker — and the dev Compliance
    // dashboard that mirrors it — count a student "engaged" only when BOTH AY
    // and BA are recent; without the BA stamp a senior who just checked in still
    // gets a "reconnect with Aaron" nudge, because BA never moves for them (they
    // have no separate Aaron check-in). Keep both columns in lockstep for seniors.
    // See Google Apps Scripts/checkin-reminder/checkinReminder.gs.
    if (isSenior) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: MASTER_SHEET_ID,
        requestBody: {
          valueInputOption: 'USER_ENTERED',
          data: [
            { range: `${MASTER_TAB}!AY${studentRowIndex}`, values: [[now]] },
            { range: `${MASTER_TAB}!BA${studentRowIndex}`, values: [[now]] },
          ],
        },
      });
    } else {
      await sheets.spreadsheets.values.update({
        spreadsheetId: MASTER_SHEET_ID,
        range: `${MASTER_TAB}!AY${studentRowIndex}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[now]] },
      });
    }

    // ── 3. Build concatenated strings for CheckinForm ────────────────────────
    const gradeSnapshot = classes?.length
      ? buildGradeSnapshot(classes, grades.map(g => g.grade))
      : '';

    const actionItemsString = (actionItemStatuses || [])
      .map(({ task, status }) => `${task}: ${status}`)
      .join('; ');

    // ── 4. Append new row to CheckinForm ─────────────────────────────────────
    // Column order: A=Timestamp, B=Name, C=Grades, D=Tests&Deadlines,
    // E=Task Updates, F=Q/C Category, G=Q/C Text, H=Self-Rating, I=Response Pref
    await sheets.spreadsheets.values.append({
      spreadsheetId: MASTER_SHEET_ID,
      range: `${CHECKIN_TAB}!A:I`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [[
          now,                      // A: Timestamp
          studentName || '',        // B: Name
          gradeSnapshot,            // C: Grades (concatenated)
          testsAndDeadlines || '',  // D: Tests & Deadlines
          actionItemsString || '',  // E: Task Updates (concatenated)
          questionsCategory || '',  // F: Questions/Concerns Category
          questionsText || '',      // G: Questions/Concerns Text
          selfRating || '',         // H: Self-Rating
          responsePreference || '', // I: Response Preference
        ]],
      },
    });

    // Senior check-in is record-only — but it ALSO grants this week's booking
    // tokens (one week's worth, spendable across the current+next Saturday-week).
    // The grant is the auditable record that unlocks booking; a new check-in
    // supersedes the prior grant. See lib/seniors.js createCheckinGrant.
    if (isSenior) {
      try {
        const senior = await getSeniorBySheetId(studentSheetId);
        if (senior) {
          await createCheckinGrant(senior, DateTime.now().setZone('America/Los_Angeles'));
        }
      } catch (grantErr) {
        console.error('Failed to write senior check-in grant:', grantErr);
        return Response.json({ error: 'Check-in saved, but unlocking booking failed. Please retry.' }, { status: 500 });
      }
      return Response.json({ success: true, senior: true });
    }

    // ── 5. Fetch grade history (last 3 submissions) for AI context ───────────
    const checkinRes = await sheets.spreadsheets.values.get({
      spreadsheetId: MASTER_SHEET_ID,
      range: `${CHECKIN_TAB}!A:I`,
      valueRenderOption: 'UNFORMATTED_VALUE',
    });

    const allCheckins = checkinRes.data.values || [];
    // Filter to this student's rows (col B = name), skip header if present
    const studentCheckins = allCheckins
      .filter(r => r[1] === studentName)
      .slice(-4, -1); // last 3 before current submission

    const gradeHistory = studentCheckins.map(r => ({
      timestamp: r[0],
      snapshot: parseGradeSnapshot(r[2]),
    }));

    // Current snapshot
    const currentSnapshot = parseGradeSnapshot(gradeSnapshot);
    const currentGPA = calculateGPA(currentSnapshot);

    // Grade drops vs most recent previous submission
    const mostRecent = gradeHistory[gradeHistory.length - 1];
    const gradeDrops = mostRecent
      ? detectGradeDrops(mostRecent.snapshot, currentSnapshot)
      : [];

    // ── 5b. Summer-timeline context ─────────────────────────────────────────
    // The student's active 🏆 Comps & Projects (deadlines / % complete) are the
    // in-sheet mirror of their summer timeline, so Claude can weigh urgency
    // against where their projects actually stand. Best-effort: eval proceeds
    // without it if the read fails.
    let timelineText = 'No active projects on record.';
    let behindSchedule = [];
    try {
      if (studentSheetId) {
        // Flag-gated 🏆 Comps & Projects rows (Sheets today). E:N is a superset of
        // the old E:L read; the indices used below (0,3,4,6) are unchanged.
        const projectRows = await getProjectRows(sheets, studentSheetId);
        const fmtDate = (raw) => {
          if (raw === '' || raw == null) return '';
          const d = typeof raw === 'number' ? new Date((raw - 25569) * 86400 * 1000) : new Date(raw);
          return isNaN(d) ? String(raw) : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        };
        const pct = (raw) => {
          if (raw === '' || raw == null) return null;
          const n = typeof raw === 'number' ? raw : parseFloat(String(raw).replace('%', ''));
          if (!Number.isFinite(n)) return null;
          return n > 0 && n <= 1 ? Math.round(n * 100) : Math.round(n);
        };
        const active = (projectRows || [])
          .slice(1)
          .filter((r) => r[6] === '🟢' || r[6] === '✅')
          .map((r) => ({ activity: r[0] || '', deadline: fmtDate(r[3]), pct: pct(r[4]), status: r[6] || '' }))
          .filter((p) => p.activity);
        if (active.length) {
          timelineText = active
            .map((p) => `- ${p.activity}: ${p.pct == null ? '?' : p.pct}% complete${p.deadline ? `, deadline ${p.deadline}` : ''} (${p.status})`)
            .join('\n');
          behindSchedule = active.filter((p) => p.pct != null && p.pct < 50 && p.deadline);
        }
      }
    } catch (projErr) {
      console.error('submitUpdateForm: project context fetch failed', projErr);
    }

    // ── 6. Urgency evaluation ────────────────────────────────────────────────
    // Outcome is 'written' (no meeting — generate a report) or 'pending' (a
    // meeting MAY be warranted → email Ryan to approve/reject). We NO LONGER
    // auto-grant a booking token; the student cannot book until Ryan grants one.
    let outcome = 'written';
    let suggestedLength = '15min';
    let reason = '';
    let skipClaude = false;

    // Block override: Ryan unavailable today → straight to a written report.
    const today = DateTime.now().setZone('America/Los_Angeles').toFormat('yyyy-LL-dd');
    const blocks = await listBlocksForBooking(sheets).catch(() => []);
    if (isDateBlocked(blocks, 'ryan', today)) {
      outcome = 'written';
      reason = 'Ryan is unavailable today — routed to a written report.';
      skipClaude = true;
    }

    const currentGradesText = Object.entries(currentSnapshot).length
      ? Object.entries(currentSnapshot).map(([cls, g]) => `${cls}: ${g}`).join(', ')
      : 'No grade data (summer / MS student).';

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const systemPrompt = `You decide whether a student's WEEKLY SUMMER check-in should be routed to their counselor Ryan for a possible meeting.

IMPORTANT: setting meeting = true does NOT grant a meeting — it emails Ryan, who approves or rejects with one click. So the real question is "does this deserve Ryan's eyes?" The costs are asymmetric: a wrong "true" costs Ryan one click to reject; a wrong "false" SILENTLY denies a student with no human ever reviewing it. When an explicit request is involved, lean true.

CONTEXT — IT IS SUMMER. Meetings are as-needed, not weekly; a written update is the healthy default for routine check-ins. Students used to a weekly cadence over-request out of habit — do not cater to habit for vague or low-content check-ins.

Set meeting = TRUE when ANY of these hold:
- The concern category is "Need to Discuss" AND the concern text names at least one real topic, question, or issue (i.e. it is not blank or a throwaway). An explicit, substantiated request to discuss ALWAYS goes to Ryan. A good self-rating does NOT override this — the self-rating is how their week went, not whether they need to talk something through.
- A low self-rating (1–3) paired with any concrete stressor.
- An active project clearly behind schedule (well under 50% with a deadline approaching) where the student signals they are stuck or off-track.
- A genuinely complex or multi-part question that writing cannot resolve well.

Set meeting = FALSE (written report) when:
- The concern category is "None" or blank.
- The category is "Quick Question" (or "Need to Discuss" with empty/throwaway text) AND none of the TRUE conditions above are triggered — a routine status update a written reply handles fine.
- A quiet, on-track week with a mid-to-high self-rating and no explicit, substantiated request to discuss.

A mid-to-high self-rating (4–10) is NEVER, by itself, a reason to deny an explicit "Need to Discuss" request with real content.

If meeting = true, set suggestedLength: "30min" only for genuinely complex or multi-issue situations; otherwise "15min". (Ryan makes the final call regardless.)

Respond with ONLY a JSON object — no markdown, no extra text:
{"meeting": true|false, "suggestedLength": "15min"|"30min", "reason": "one-sentence justification addressed to Ryan"}`;

    const userMessage = `Student: ${studentName}

WEEK SELF-RATING (how'd the week go, 1-10): ${selfRating}/10

QUESTIONS/CONCERNS:
Category: ${questionsCategory || 'None'}
Details: ${questionsText || 'N/A'}

TESTS & DEADLINES THEY REPORTED:
${testsAndDeadlines || 'None reported'}

TASK UPDATES:
${actionItemStatuses?.map(({ task, status }) => `- ${task}: ${status}`).join('\n') || 'None reported'}

SUMMER PROJECT TIMELINE (active Comps & Projects — weigh urgency against these):
${timelineText}

CURRENT GRADES (usually none in summer): ${currentGradesText}`;

    if (!skipClaude) {
      try {
        const aiResponse = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 150,
          system: systemPrompt,
          messages: [{ role: 'user', content: userMessage }],
        });
        const rawText = aiResponse.content[0]?.text || '{}';
        console.log('AI raw response:', rawText);
        const cleaned = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();
        const parsed = JSON.parse(cleaned);
        outcome = parsed.meeting === true ? 'pending' : 'written';
        suggestedLength = parsed.suggestedLength === '30min' ? '30min' : '15min';
        reason = parsed.reason || reason;
      } catch (aiErr) {
        // Fail safe: on any model/parse failure, default to a written report
        // rather than emailing Ryan an unjustified meeting request.
        console.error('submitUpdateForm: eval failed, defaulting to written', aiErr);
        outcome = 'written';
        reason = reason || 'Could not evaluate urgency — defaulted to a written report.';
      }
    }

    // AZ value: 'pending' = awaiting Ryan's approval (un-bookable); 'written' =
    // no meeting. A real booking token ('15min'/'30min') is written ONLY when
    // Ryan grants, in /api/checkinDecision.
    const decision = outcome === 'pending' ? 'pending' : 'written';

    // ── 7. Write decision to 👩‍🎓 All Data col AZ ────────────────────────────
    await sheets.spreadsheets.values.update({
      spreadsheetId: MASTER_SHEET_ID,
      range: `${MASTER_TAB}!AZ${studentRowIndex}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[decision]] },
    });

    // ── 8. Stamp the just-appended CheckinForm row: K=reason, L=status ────────
    const allRowsRes = await sheets.spreadsheets.values.get({
      spreadsheetId: MASTER_SHEET_ID,
      range: `${CHECKIN_TAB}!A:L`,
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    const checkinRows = allRowsRes.data.values || [];
    let lastMatchIndex = -1;
    checkinRows.forEach((r, i) => { if (r[1] === studentName) lastMatchIndex = i; });
    const checkinRow = lastMatchIndex + 1; // 1-based sheet row of this submission

    if (lastMatchIndex > -1) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: MASTER_SHEET_ID,
        requestBody: {
          valueInputOption: 'USER_ENTERED',
          data: [
            { range: `${CHECKIN_TAB}!K${checkinRow}`, values: [[reason || '']] },
            { range: `${CHECKIN_TAB}!L${checkinRow}`, values: [[decision]] },
          ],
        },
      });
    }

    // ── 9. Act on the outcome ────────────────────────────────────────────────
    if (outcome === 'pending' && lastMatchIndex > -1) {
      // Email Ryan to approve/reject. Signed tokens carry everything the grant
      // endpoint needs (Ryan clicks from his inbox, with no Clerk session).
      const tokenBase = { masterRow: studentRowIndex, checkinRow, studentSheetId, studentName };
      const tokens = {
        grant15: makeApprovalToken({ ...tokenBase, action: 'grant15' }),
        grant30: makeApprovalToken({ ...tokenBase, action: 'grant30' }),
        reject: makeApprovalToken({ ...tokenBase, action: 'reject' }),
      };
      const signals = [
        `Self-rating: ${selfRating}/10`,
        questionsCategory && questionsCategory !== 'None'
          ? `Concern (${questionsCategory}): ${questionsText || '—'}`
          : null,
        testsAndDeadlines ? `Tests/deadlines: ${testsAndDeadlines}` : null,
        behindSchedule.length
          ? `Behind schedule: ${behindSchedule.map((p) => `${p.activity} (${p.pct}%)`).join('; ')}`
          : null,
      ];
      try {
        await sendRyanMeetingRequestEmail({ studentName, reason, suggestedLength, signals, tokens });
      } catch (mailErr) {
        console.error('submitUpdateForm: failed to email Ryan', mailErr);
      }
    } else if (outcome === 'written') {
      const start = Date.now();
      await triggerReportGeneration(studentName, studentSheetId);
      console.log('Report generation took', Date.now() - start, 'ms');
    }

    return Response.json({ success: true, outcome, decision, reason });

  } catch (err) {
    console.error('submitUpdateForm error:', err);
    return Response.json({ error: err.message || 'Server error' }, { status: 500 });
  }
}
