import Anthropic from '@anthropic-ai/sdk';
import nodemailer from 'nodemailer';
import { google } from 'googleapis';

const MASTER_SHEET_ID = '1YJK05oU_12wX0qK-vTqJJfaS8eVI7JMzdGP0gVso1G4';
const MASTER_TAB = '👩‍🎓 All Data';
const PARENT_CHECKIN_TAB = 'ParentCheckins';
const REPORT_TO = 'support@admissions.partners';
const REPORT_CC = 'info@sapientacademy.com';

function getServiceAuth() {
  return new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

// Convert JS Date to Pacific time string: "Thu Mar 12, 5:34 pm PT"
function toPacificString(date) {
  return date.toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'America/Los_Angeles',
  }).replace(',', '') + ' PT';
}

// Calculate days since last non-email-only request for this parent email
function calcDaysSinceLastRequest(parentEmail, checkinRows) {
  // Col B = index 1 (parent email), Col G = index 6 (urgency)
  const priorRequests = checkinRows
    .filter(r =>
      r[1]?.toLowerCase() === parentEmail.toLowerCase() &&
      r[6] && r[6] !== 'Email only' &&
      r[0] // has timestamp
    )
    .sort((a, b) => new Date(b[0]) - new Date(a[0])); // most recent first

  if (!priorRequests.length) return null;

  const lastDate = new Date(priorRequests[0][0]);
  const now = new Date();
  const diffMs = now - lastDate;
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

function buildHtmlEmail({
  timestamp, parentEmail, studentName, studentNameStatus,
  daysSinceLastRequest, purpose, deadlines, urgencyLevel, reasoning,
}) {
  const daysSinceText = daysSinceLastRequest !== null
    ? `${daysSinceLastRequest} days`
    : 'No prior requests on record';

  let flagNote = '';
  if (studentNameStatus === 'inferred') {
    flagNote = `<p style="background:#fff3cd;border:1px solid #ffc107;border-radius:6px;padding:8px 12px;font-size:11pt;margin:8px 0;">
        ⚠️ Parent email not found in master sheet. Student name was inferred from the message — please verify.
       </p>`;
  } else if (studentNameStatus === 'unknown') {
    flagNote = `<p style="background:#f8d7da;border:1px solid #dc3545;border-radius:6px;padding:8px 12px;font-size:11pt;margin:8px 0;">
        ⚠️ Parent email not found in master sheet and the student could not be identified from the message. Urgency below was assessed from the request alone — manual review recommended.
       </p>`;
  }

  return `<!DOCTYPE html>
<html>
<head>
  <link href="https://fonts.googleapis.com/css2?family=Figtree:ital,wght@0,400;0,700;1,400;1,700&family=Bitter:ital,wght@0,400;0,700;1,400&display=swap" rel="stylesheet">
</head>
<body style="font-family:'Bitter',Georgia,serif;font-size:12pt;color:#000;line-height:1.15;max-width:680px;margin:0 auto;padding:24px;">

  ${flagNote}

  <h1 style="font-family:'Figtree',sans-serif;font-size:18px;color:#763f21;font-weight:bold;font-style:italic;text-transform:uppercase;margin:0 0 12px;">Profile Info</h1>

  <p style="margin:4px 0;"><strong>Time submitted:</strong> ${timestamp}</p>
  <p style="margin:4px 0;"><strong>Parent email:</strong> ${parentEmail}</p>
  <p style="margin:4px 0;"><strong>Student name:</strong> ${studentName}</p>
  <p style="margin:4px 0 16px;"><strong>Days since last parent meeting request:</strong> ${daysSinceText}</p>

  <h1 style="font-family:'Figtree',sans-serif;font-size:18px;color:#763f21;font-weight:bold;font-style:italic;text-transform:uppercase;margin:16px 0 8px;">Meeting Request Details</h1>

  <h2 style="font-family:'Figtree',sans-serif;font-size:15px;color:#2f5034;font-style:italic;font-weight:normal;margin:12px 0 4px;">Meeting Purpose</h2>
  <p style="margin:4px 0 12px;">${purpose}</p>

  <h2 style="font-family:'Figtree',sans-serif;font-size:15px;color:#2f5034;font-style:italic;font-weight:normal;margin:12px 0 4px;">Relevant Deadlines</h2>
  <p style="margin:4px 0 12px;">${deadlines}</p>

  <h1 style="font-family:'Figtree',sans-serif;font-size:18px;color:#763f21;font-weight:bold;font-style:italic;text-transform:uppercase;margin:16px 0 8px;">Urgency Evaluation</h1>

  <h2 style="font-family:'Figtree',sans-serif;font-size:15px;color:#2f5034;font-style:italic;font-weight:normal;margin:12px 0 4px;">Urgency Level</h2>
  <p style="margin:4px 0 12px;"><strong>${urgencyLevel}</strong></p>

  <h2 style="font-family:'Figtree',sans-serif;font-size:15px;color:#2f5034;font-style:italic;font-weight:normal;margin:12px 0 4px;">Reasoning</h2>
  <p style="margin:4px 0;">${reasoning}</p>

</body>
</html>`;
}

function buildPlainText({
  timestamp, parentEmail, studentName, studentNameStatus,
  daysSinceLastRequest, purpose, deadlines, urgencyLevel, reasoning,
}) {
  const daysSinceText = daysSinceLastRequest !== null
    ? `${daysSinceLastRequest} days`
    : 'No prior requests on record';

  let flagLine = '';
  if (studentNameStatus === 'inferred') {
    flagLine = '⚠️ Parent email not found — student name inferred from message; please verify.\n';
  } else if (studentNameStatus === 'unknown') {
    flagLine = '⚠️ Parent email not found and student could not be identified from message. Urgency assessed from request content alone — manual review recommended.\n';
  }

  return `PROFILE INFO
${flagLine}
Time submitted: ${timestamp}
Parent email: ${parentEmail}
Student name: ${studentName}
Days since last parent meeting request: ${daysSinceText}

MEETING REQUEST DETAILS

Meeting Purpose
${purpose}

Relevant Deadlines
${deadlines}

URGENCY EVALUATION

Urgency Level
${urgencyLevel}

Reasoning
${reasoning}`;
}

export async function POST(request) {
  try {
    const { parentEmail, concern } = await request.json();
    if (!parentEmail || !concern) {
      return Response.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const authClient = getServiceAuth();
    const sheets = google.sheets({ version: 'v4', auth: authClient });

    // ── 1. Fetch master sheet data + ParentCheckins in parallel ──────────────
    const [masterRes, checkinRes] = await Promise.all([
      sheets.spreadsheets.values.get({
        spreadsheetId: MASTER_SHEET_ID,
        range: `${MASTER_TAB}!A:AL`,
        valueRenderOption: 'UNFORMATTED_VALUE',
      }),
      sheets.spreadsheets.values.get({
        spreadsheetId: MASTER_SHEET_ID,
        range: `${PARENT_CHECKIN_TAB}!A:H`,
        valueRenderOption: 'UNFORMATTED_VALUE',
      }),
    ]);

    const masterRows = masterRes.data.values || [];
    const checkinRows = checkinRes.data.values || [];

    // ── 2. VLOOKUP parent email against col K (index 10) and col L (index 11) ─
    // Col A=0, K=10, L=11, AL=37
    // String() coercion guards against numeric/non-string cells in K/L that
    // would otherwise crash .toLowerCase() and bubble up as a 500.
    const target = parentEmail.toLowerCase();
    const studentRow = masterRows.find(r => {
      const colK = String(r?.[10] ?? '').toLowerCase();
      const colL = String(r?.[11] ?? '').toLowerCase();
      return colK === target || colL === target;
    });

    let studentName = studentRow?.[0] || null;
    const packageType = studentRow?.[37] || '';
    let studentNameStatus = studentName ? 'matched' : 'unknown';

    // ── 3. Calculate days since last non-email request ───────────────────────
    const daysSinceLastRequest = calcDaysSinceLastRequest(parentEmail, checkinRows);

    // ── 4. Build context for Claude ──────────────────────────────────────────
    const today = new Date();
    const todayStr = today.toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    });

    const alreadyHadMeetingThisMonth = checkinRows.some(r => {
      if (String(r?.[1] ?? '').toLowerCase() !== target) return false;
      if (!r[0] || r[6] === 'Email only') return false;
      const rowDate = new Date(r[0]);
      return rowDate.getMonth() === today.getMonth() &&
             rowDate.getFullYear() === today.getFullYear();
    });

    const systemPrompt = `You are an assistant for an academic counseling firm. Analyze parent meeting requests and return a JSON object.

TODAY: ${todayStr}

${studentName
  ? `STUDENT: ${studentName} | Package: ${packageType || 'not listed'}`
  : `STUDENT: Unknown — the parent email is not in our records. If the parent clearly names their child in the message, return that name as studentName; otherwise return null. IMPORTANT: still produce a full urgency evaluation based on the request content alone. Do not refuse or downgrade urgency simply because the student could not be identified.`}

URGENCY RULES:
Urgency signals (push toward urgent/semi-urgent):
- Deadline less than 1 week from today
- High complexity question
- Package type is "VIP"

Non-urgency signals (push toward non-urgent/email only):
- Parent already had a meeting approved this calendar month: ${alreadyHadMeetingThisMonth}
- No deadline stated
- Deadline 2+ weeks away
- Package type is "Essential"

No-impact signals:
- Parent emotional tone (upset, frustrated, etc.) does NOT increase urgency
- If package type is not listed or unknown, ignore that factor entirely
- Inability to identify the student does NOT change urgency — judge from the request itself

URGENCY LEVELS (use exactly as written):
- "Urgent: 1 biz. day"
- "Semi-Urgent: 3–4 biz. days"
- "Non-urgent: 7+ biz. days"
- "Email only"

Return ONLY a valid JSON object, no markdown, no explanation:
{
  "studentName": "Full Name or null",
  "purpose": "2-3 sentence summary of meeting purpose",
  "deadlines": "extracted deadline(s) or N/A",
  "urgencyLevel": "one of the four levels above",
  "reasoning": "1-2 sentences explaining the decision"
}`;

    // ── 5. Call Claude Haiku ─────────────────────────────────────────────────
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const aiResponse = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      system: systemPrompt,
      messages: [{ role: 'user', content: concern }],
    });

    let parsed;
    try {
      const raw = aiResponse.content[0]?.text || '{}';
      const cleaned = raw.replace(/```json|```/g, '').trim();
      parsed = JSON.parse(cleaned);
    } catch {
      console.error('Failed to parse Claude response');
      parsed = {
        studentName: null,
        purpose: concern.slice(0, 200),
        deadlines: 'N/A',
        urgencyLevel: 'Non-urgent: 7+ biz. days',
        reasoning: 'Unable to parse AI response — manual review required.',
      };
    }

    // Resolve student name. Three states:
    //   'matched'  — email hit the master sheet
    //   'inferred' — email missed, but Claude pulled a name from the message
    //   'unknown'  — email missed and no name available
    if (studentNameStatus !== 'matched') {
      if (parsed.studentName && parsed.studentName !== 'null') {
        studentName = parsed.studentName;
        studentNameStatus = 'inferred';
      } else {
        studentName = 'Unknown';
        studentNameStatus = 'unknown';
      }
    }

    const timestamp = toPacificString(today);
    const nowISO = today.toISOString();

    // ── 6. Append row to ParentCheckins tab ──────────────────────────────────
    // A=Timestamp, B=ParentEmail, C=StudentName, D=Purpose, E=Deadlines,
    // F=DaysSinceLastRequest, G=UrgencyLevel, H=Reasoning
    await sheets.spreadsheets.values.append({
      spreadsheetId: MASTER_SHEET_ID,
      range: `${PARENT_CHECKIN_TAB}!A:H`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [[
          nowISO,
          parentEmail,
          studentName,
          parsed.purpose || '',
          parsed.deadlines || 'N/A',
          daysSinceLastRequest !== null ? daysSinceLastRequest : '',
          parsed.urgencyLevel || '',
          parsed.reasoning || '',
        ]],
      },
    });

    // ── 7. Send email ────────────────────────────────────────────────────────
    const emailData = {
      timestamp,
      parentEmail,
      studentName,
      studentNameStatus,
      daysSinceLastRequest,
      purpose: parsed.purpose || concern.slice(0, 300),
      deadlines: parsed.deadlines || 'N/A',
      urgencyLevel: parsed.urgencyLevel || 'Unknown',
      reasoning: parsed.reasoning || '',
    };

    const subjectStudent = studentNameStatus === 'unknown'
      ? '[Student unknown]'
      : studentNameStatus === 'inferred'
        ? `${studentName} (unverified)`
        : studentName;

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
      subject: `Parent Meeting Request: ${subjectStudent} — ${parsed.urgencyLevel || 'Review needed'}`,
      text: buildPlainText(emailData),
      html: buildHtmlEmail(emailData),
    });

    return Response.json({ success: true });

  } catch (err) {
    console.error('parentCheckin error:', err);
    return Response.json({ error: err.message || 'Server error' }, { status: 500 });
  }
}