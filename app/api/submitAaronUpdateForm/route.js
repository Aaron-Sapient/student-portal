import { auth } from '@clerk/nextjs/server';
import { google } from 'googleapis';
import Anthropic from '@anthropic-ai/sdk';

const MASTER_SHEET_ID = '1YJK05oU_12wX0qK-vTqJJfaS8eVI7JMzdGP0gVso1G4';
const MASTER_TAB = '👩‍🎓 All Data';
const CHECKIN_TAB = 'A_CheckinForm';

function getServiceAuth() {
  return new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

export async function POST(request) {
  const { sessionClaims } = await auth();
  const email = sessionClaims?.email;
  if (!email) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const body = await request.json();
    const {
      studentRowIndex,
      studentName,
      taskUpdates,         // [{ task, status }]
      upcomingDeadlines,
      questionsCategory,
      questionsText,
      responsePreference,
    } = body;

    const authClient = getServiceAuth();
    const sheets = google.sheets({ version: 'v4', auth: authClient });

    const now = new Date().toISOString();

    // ── 1. Overwrite BA timestamp in 👩‍🎓 All Data ───────────────────────────
    await sheets.spreadsheets.values.update({
      spreadsheetId: MASTER_SHEET_ID,
      range: `${MASTER_TAB}!BA${studentRowIndex}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[now]] },
    });

    // ── 2. Build concatenated task-updates string ────────────────────────────
    const taskUpdatesString = (taskUpdates || [])
      .map(({ task, status }) => `${task}: ${status}`)
      .join('; ');

    // ── 3. Append new row to A_CheckinForm ───────────────────────────────────
    // Column order: A=Timestamp, B=Name, C=Task Updates, D=Upcoming Deadlines,
    // E=Questions Category, F=Questions Text, G=Response Preference,
    // H=Agenda (filled later by bookMeeting), I=Claude Reason, J=Booking Decision
    await sheets.spreadsheets.values.append({
      spreadsheetId: MASTER_SHEET_ID,
      range: `${CHECKIN_TAB}!A:J`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [[
          now,                        // A: Timestamp
          studentName || '',          // B: Name
          taskUpdatesString,          // C: Task Updates (concatenated)
          upcomingDeadlines || '',    // D: Upcoming Deadlines
          questionsCategory || '',    // E: Questions Category
          questionsText || '',        // F: Questions Text
          responsePreference || '',   // G: Response Preference
          '',                         // H: Agenda (filled by bookMeeting)
          '',                         // I: Claude Reason (filled below)
          '',                         // J: Booking Decision (filled below)
        ]],
      },
    });

    // ── 4a. VIP override: skip Claude entirely if col AL = "VIP" and student requested 30min.
    // The frontend sees an ordinary 30min decision — no flag is exposed in the response.
    let decision = '15min';
    let reason = '';
    let vipOverride = false;

    const vipRes = await sheets.spreadsheets.values.get({
      spreadsheetId: MASTER_SHEET_ID,
      range: `${MASTER_TAB}!AL${studentRowIndex}`,
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    const vipFlag = String(vipRes.data.values?.[0]?.[0] || '').trim().toUpperCase();
    if (vipFlag === 'VIP' && responsePreference === '30min') {
      decision = '30min';
      reason = 'VIP auto-routed to 30min per student request.';
      vipOverride = true;
    }

    // ── 4b. Call Claude for routing decision (balanced 60/35/5 distribution) ──
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const systemPrompt = `You are a routing assistant for an academic counseling service.
Your job is to decide which response a student should receive after their weekly check-in with Aaron.

RESPONSE TYPES (with target distribution):
- "15min": A 15-minute phone call. Target ~60% of weeks. The default for most students.
- "30min": A 30-minute Zoom meeting. Target ~35% of weeks. For complex tasks, multiple open questions, or when a student needs deeper guidance.
- "email": Finalize over email — no live meeting. Target ~5% of weeks. ONLY when the student explicitly requests "Ready to finalize over email".

DECISION RULES:

HARD RULE: Return "email" ONLY if the student's response preference is exactly "Ready to finalize over email". Otherwise, never return "email".

Between "15min" and "30min", weigh these signals:

Push toward "30min":
- Questions/Concerns category is "Need to Discuss"
- Questions text describes multiple distinct topics or a complex decision
- Three or more substantive task updates (especially if any are "Not Started" or "In Progress" with blockers)
- Student's response preference is "30min"

Push toward "15min" (the default):
- Questions/Concerns category is "Quick Question" or "None"
- Questions text is short, focused, or empty
- Tasks are largely "Completed" or routine
- Student's response preference is "15min"

DEFAULT: Lean toward "15min". Only escalate to "30min" when there are real signals of complexity. Aaron expects most students to be "15min" — that's the healthy baseline.

Respond with ONLY a JSON object. No explanation, no markdown, no extra text:
{"decision": "15min"|"30min"|"email", "reason": "one sentence explanation"}`;

    const userMessage = `Student: ${studentName}

TASK UPDATES:
${taskUpdates?.map(({ task, status }) => `- ${task}: ${status}`).join('\n') || 'None reported'}

UPCOMING DEADLINES:
${upcomingDeadlines || 'None reported'}

QUESTIONS/CONCERNS:
Category: ${questionsCategory || 'None'}
Details: ${questionsText || 'N/A'}

STUDENT RESPONSE PREFERENCE: ${responsePreference || 'No preference'}`;

    if (!vipOverride) {
      const aiResponse = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 150,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      });

      try {
        const rawText = aiResponse.content[0]?.text || '{}';
        console.log('Aaron AI raw response:', rawText);
        const cleaned = rawText
          .replace(/```json/gi, '')
          .replace(/```/g, '')
          .trim();
        const parsed = JSON.parse(cleaned);
        decision = ['15min', '30min', 'email'].includes(parsed.decision)
          ? parsed.decision
          : '15min';
        reason = parsed.reason || '';
      } catch {
        console.error('Failed to parse Aaron AI response, defaulting to 15min');
        decision = '15min';
      }

      // Safety override: only allow "email" if student explicitly requested it
      if (decision === 'email' && responsePreference !== 'Ready to finalize over email') {
        decision = '15min';
        reason = 'Student did not explicitly request email-only — defaulting to 15min.';
      }
    }

    // ── 5. Write booking decision to 👩‍🎓 All Data col BB ──────────────────
    await sheets.spreadsheets.values.update({
      spreadsheetId: MASTER_SHEET_ID,
      range: `${MASTER_TAB}!BB${studentRowIndex}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[decision]] },
    });

    // ── 6. Backfill AI reason (col I) and decision (col J) on the appended row ──
    const allRowsRes = await sheets.spreadsheets.values.get({
      spreadsheetId: MASTER_SHEET_ID,
      range: `${CHECKIN_TAB}!A:J`,
      valueRenderOption: 'UNFORMATTED_VALUE',
    });

    const checkinRows = allRowsRes.data.values || [];
    let lastMatchIndex = -1;
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
            { range: `${CHECKIN_TAB}!I${sheetRow}`, values: [[reason || '']] },
            { range: `${CHECKIN_TAB}!J${sheetRow}`, values: [[decision]] },
          ],
        },
      });
    }

    return Response.json({ success: true, decision, reason });

  } catch (err) {
    console.error('submitAaronUpdateForm error:', err);
    return Response.json({ error: err.message || 'Server error' }, { status: 500 });
  }
}
