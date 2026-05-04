import { auth } from '@clerk/nextjs/server';
import { google } from 'googleapis';
import { DateTime } from 'luxon';
import Anthropic from '@anthropic-ai/sdk';
import { triggerReportGeneration } from '@/lib/generateReport';
import { listBlocks, isDateBlocked } from '@/lib/blocks';

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

    // ── 2. Overwrite AY timestamp in 👩‍🎓 All Data ───────────────────────────
    await sheets.spreadsheets.values.update({
      spreadsheetId: MASTER_SHEET_ID,
      range: `${MASTER_TAB}!AY${studentRowIndex}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[now]] },
    });

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

    // ── 5b. Block override: if Ryan is blocked off today, force "written" and skip Claude.
    // Only applies to Ryan — Aaron's availability is unaffected by Ryan's blocks.
    let decision = 'written';
    let reason = '';
    let blockOverride = false;

    const today = DateTime.now().setZone('America/Los_Angeles').toFormat('yyyy-LL-dd');
    const blocks = await listBlocks(sheets).catch(() => []);
    if (isDateBlocked(blocks, 'ryan', today)) {
      decision = 'written';
      reason = 'Ryan is unavailable today — auto-routed to a written report.';
      blockOverride = true;
    }

    // ── 6. Call Claude Haiku for routing decision ────────────────────────────
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const gradeHistoryText = gradeHistory.length
      ? gradeHistory.map((h, i) => {
          const gpa = calculateGPA(h.snapshot);
          const entries = Object.entries(h.snapshot)
            .map(([cls, g]) => `${cls}: ${g}`)
            .join(', ');
          return `Submission ${i + 1} (${h.timestamp?.split('T')[0] || 'unknown'}): GPA ${gpa ?? 'N/A'} — ${entries}`;
        }).join('\n')
      : 'No previous submissions on record.';

const gradeDropText = gradeDrops.length
  ? gradeDrops.map(d =>
      `${d.class}: ${d.from} → ${d.to} (${d.drop} point drop${d.isSignificant ? ', SIGNIFICANT' : ''}${d.isDanger ? ', DANGER ZONE (D/F)' : ''})`
    ).join('\n')
  : gradeHistory.length === 0
    ? 'No previous submissions to compare against — evaluate current grades directly.'
    : 'No grade drops detected since last submission.';

    const currentGradesText = Object.entries(currentSnapshot).length
      ? Object.entries(currentSnapshot).map(([cls, g]) => `${cls}: ${g}`).join(', ')
      : 'No grade data submitted (MS student or summer).';

    const systemPrompt = `You are a routing assistant for an academic counseling service. 
Your job is to decide which response a student should receive after their weekly check-in.

RESPONSE TYPES (with target distribution):
- "written": A written report is sent. Target 60% of weeks. Default unless escalation signals are present.
- "15min": A 15-minute phone call. Target 20% of weeks. For specific questions or minor concerns.
- "30min": A 30-minute Zoom meeting. Target 10% of weeks. For critical decisions or major concerns.

DECISION RULES (apply in order of weight):

TOP WEIGHT signals that strongly push to "written" and automatically disqualify "30min" regardless of any other signals:
- Questions/Concerns text is left blank or lazy response (i.e., just the word "meeting") (this signals low engagement)
- ALL task updates marked as "Not Started" (this also signals low engagement)
- NEVER escalate *above* what a student requests (i.e., never give 30min for a 15min request)
- If a student needs a meeting, *strongly favor 15min* over 30min except in rare, exceptionally complex cases

HIGH WEIGHT signals that escalate toward a meeting:
- Grade drop of 1.0+ GPA points in any class (e.g. B to C or worse)
- Any class currently at D or F
- GPA below 2.0
- Questions/Concerns category is "Need to Discuss"
- Academic self-rating of 1, 2, or 3

MEDIUM WEIGHT signals that escalate toward a meeting:
- Questions/Concerns category is "Quick Question"
- Academic self-rating of 4 or 5
- GPA between 2.0 and 2.7

LOW WEIGHT (tiebreaker only, do not override stronger signals):
- Student's response preference

DEFAULT BIAS: If no medium or high signals are present, return "written".
You must lean heavily toward "written" — only escalate when signals genuinely warrant it.

GPA CONVERSION TABLE (for reference):
A+/A = 4.0, A- = 3.7, B+ = 3.3, B = 3.0, B- = 2.7
C+ = 2.3, C = 2.0, C- = 1.7, D+ = 1.3, D = 1.0, D- = 0.7, F = 0.0

IMPORTANT: If a student has multiple HIGH WEIGHT signals simultaneously (e.g. D/F grades AND "Need to Discuss" AND self-rating ≤ 3), this should almost certainly be 30min. Do not default to written when multiple serious signals are present.

Respond with ONLY a JSON object. No explanation, no markdown, no extra text:
{"decision": "written"|"15min"|"30min", "reason": "one sentence explanation"}`;

    const userMessage = `Student: ${studentName}

CURRENT GRADES (this week):
${currentGradesText}
Current GPA: ${currentGPA ?? 'N/A'}

GRADE HISTORY (previous submissions):
${gradeHistoryText}

GRADE CHANGES SINCE LAST SUBMISSION:
${gradeDropText}

TESTS & DEADLINES THIS WEEK:
${testsAndDeadlines || 'None reported'}

ACTION ITEMS:
${actionItemStatuses?.map(({ task, status }) => `- ${task}: ${status}`).join('\n') || 'None reported'}

QUESTIONS/CONCERNS:
Category: ${questionsCategory || 'None'}
Details: ${questionsText || 'N/A'}

ACADEMIC SELF-RATING: ${selfRating}/10

STUDENT RESPONSE PREFERENCE: ${responsePreference || 'No preference'}`;

    if (!blockOverride) {
      const aiResponse = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 150,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      });

      try {
        const rawText = aiResponse.content[0]?.text || '{}';
        console.log('AI raw response:', rawText);
        const cleaned = rawText
          .replace(/```json/gi, '')
          .replace(/```/g, '')
          .trim();
        const parsed = JSON.parse(cleaned);
        decision = ['written', '15min', '30min'].includes(parsed.decision)
          ? parsed.decision
          : 'written';
        reason = parsed.reason || '';
      } catch {
        console.error('Failed to parse AI response, defaulting to written');
        decision = 'written';
      }
    }

// ── 7. Write booking decision to 👩‍🎓 All Data col AZ ───────────────────
await sheets.spreadsheets.values.update({
  spreadsheetId: MASTER_SHEET_ID,
  range: `${MASTER_TAB}!AZ${studentRowIndex}`,
  valueInputOption: 'USER_ENTERED',
  requestBody: { values: [[decision]] },
});

// ── 8. Write AI reason to CheckinForm col K and decision to col L ────────
// We renamed this from 'checkinRes' to 'allRowsRes' to avoid the "already defined" error
const allRowsRes = await sheets.spreadsheets.values.get({
  spreadsheetId: MASTER_SHEET_ID,
  range: `${CHECKIN_TAB}!A:L`,
  valueRenderOption: 'UNFORMATTED_VALUE',
});

const checkinRows = allRowsRes.data.values || [];
let lastMatchIndex = -1;

// Find the row we JUST appended for this student
checkinRows.forEach((r, i) => {
  if (r[1] === studentName) lastMatchIndex = i;
});

if (lastMatchIndex > -1) {
  const sheetRow = lastMatchIndex + 1;
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: MASTER_SHEET_ID,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data: [
        { range: `${CHECKIN_TAB}!K${sheetRow}`, values: [[reason || '']] },
        { range: `${CHECKIN_TAB}!L${sheetRow}`, values: [[decision]] },
      ],
    },
  });
}

if (decision === 'written') {
  const start = Date.now();
  await triggerReportGeneration(studentName, studentSheetId);
  console.log('Report generation took', Date.now() - start, 'ms');
}

return Response.json({ success: true, decision, reason });

  } catch (err) {
    console.error('submitUpdateForm error:', err);
    return Response.json({ error: err.message || 'Server error' }, { status: 500 });
  }
}