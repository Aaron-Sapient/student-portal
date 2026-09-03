import Anthropic from '@anthropic-ai/sdk';
import nodemailer from 'nodemailer';
import { getSupabaseClient, PARENT_CHECKINS } from './supabase';

// Core of the parent check-in flow, shared by the public /api/parentCheckin form
// and the authenticated /api/parent/checkin portal route. Looks up the student
// (unless the caller already verified one), runs the Haiku urgency analysis,
// records the request, and emails the support inbox.
//
// ZERO-GOOGLE (Package F, 2026-09-02). Was: a Master A:AL scan to VLOOKUP the
// parent's email against cols K/L, a ParentCheckins!A:H read for history, and an
// append to that same tab — with `parent_checkins` as a best-effort mirror whose
// failure was swallowed. All three Sheets calls are gone and the mirror is now the
// record. The reconcile step that re-derived it from the tab is retired in the
// same push.
const REPORT_TO = 'support@admissions.partners';
const REPORT_CC = 'info@sapientacademy.com';

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
// `priorRows` are this parent's parent_checkins rows, newest first. Was the same
// filter over the ParentCheckins tab: col B = parent email, col G = urgency,
// col A = timestamp. "Email only" requests never counted.
function calcDaysSinceLastRequest(priorRows) {
  const priorRequests = priorRows.filter(
    (r) => r.urgency && r.urgency !== 'Email only' && r.submitted_at
  );
  if (!priorRequests.length) return null;

  const lastDate = new Date(priorRequests[0].submitted_at);
  const now = new Date();
  return Math.floor((now - lastDate) / (1000 * 60 * 60 * 24));
}

// HTML-escape anything untrusted before it lands in the email body. Both the
// model's fields and the RAW parent input reach this template: on a model-parse
// failure `purpose` falls back to concern.slice(0, 300), and `parentEmail` is
// unverified attacker input on the PUBLIC /api/parentCheckin path. Email clients
// strip scripts, but unescaped markup still lets an anonymous POST inject links
// and formatting into mail Ryan and Aaron read as trusted internal notice.
// The urgency level reaches the SUBJECT LINE, and on the public /api/parentCheckin
// path it is model output derived from anonymous attacker text. Constrain it to the
// four values the prompt actually offers rather than passing the model's string
// through — nodemailer folds/encodes headers, but an unbounded model string in a
// header is not something to rely on encoding alone for.
// The four levels, defined ONCE. The prompt below renders its list from this array
// and the validator checks against the same array, so the two can never drift apart.
// They already had: a hand-written allowlist guessed "Urgent: 1-2 biz. days" while the
// prompt offers "Urgent: 1 biz. day", which would have degraded every genuinely urgent
// request to "Review needed" — the highest-priority case, silently.
export const URGENCY_LEVELS = [
  'Urgent: 1 biz. day',
  'Semi-Urgent: 3\u20134 biz. days',
  'Non-urgent: 7+ biz. days',
  'Email only',
]
const safeUrgency = (v) => (URGENCY_LEVELS.includes(String(v ?? '')) ? String(v) : 'Review needed')

const escHtml = (v) =>
  String(v == null ? '' : v).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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

  <p style="margin:4px 0;"><strong>Time submitted:</strong> ${escHtml(timestamp)}</p>
  <p style="margin:4px 0;"><strong>Parent email:</strong> ${escHtml(parentEmail)}</p>
  <p style="margin:4px 0;"><strong>Student name:</strong> ${escHtml(studentName)}</p>
  <p style="margin:4px 0 16px;"><strong>Days since last parent meeting request:</strong> ${escHtml(daysSinceText)}</p>

  <h1 style="font-family:'Figtree',sans-serif;font-size:18px;color:#763f21;font-weight:bold;font-style:italic;text-transform:uppercase;margin:16px 0 8px;">Meeting Request Details</h1>

  <h2 style="font-family:'Figtree',sans-serif;font-size:15px;color:#2f5034;font-style:italic;font-weight:normal;margin:12px 0 4px;">Meeting Purpose</h2>
  <p style="margin:4px 0 12px;">${escHtml(purpose)}</p>

  <h2 style="font-family:'Figtree',sans-serif;font-size:15px;color:#2f5034;font-style:italic;font-weight:normal;margin:12px 0 4px;">Relevant Deadlines</h2>
  <p style="margin:4px 0 12px;">${escHtml(deadlines)}</p>

  <h1 style="font-family:'Figtree',sans-serif;font-size:18px;color:#763f21;font-weight:bold;font-style:italic;text-transform:uppercase;margin:16px 0 8px;">Urgency Evaluation</h1>

  <h2 style="font-family:'Figtree',sans-serif;font-size:15px;color:#2f5034;font-style:italic;font-weight:normal;margin:12px 0 4px;">Urgency Level</h2>
  <p style="margin:4px 0 12px;"><strong>${escHtml(urgencyLevel)}</strong></p>

  <h2 style="font-family:'Figtree',sans-serif;font-size:15px;color:#2f5034;font-style:italic;font-weight:normal;margin:12px 0 4px;">Reasoning</h2>
  <p style="margin:4px 0;">${escHtml(reasoning)}</p>

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

// When `knownStudentName` is provided (authenticated portal path), the K/L
// lookup is skipped for the name — the caller already validated the child —
// but the urgency analysis, sheet append, and email all still run.
export async function processParentCheckin({ parentEmail, concern, knownStudentName = null, knownSheetId = null }) {
  const sb = getSupabaseClient();
  const target = String(parentEmail ?? '').trim().toLowerCase();

  // ── 1. Resolve the student from `guardians` → `students` ─────────────────
  // Was a Master A:AL scan VLOOKUPing the parent email against cols K/L (with
  // String() coercion, because a numeric cell in K/L used to crash .toLowerCase()
  // and bubble up as a 500 — a cell-shape hazard that does not exist here).
  // packageType was col AL (index 37).
  //
  // A parent with two children still narrows by knownStudentName on the
  // authenticated path, exactly as the col-A name filter did.
  const { data: guardRows, error: gErr } = await sb
    .from('guardians')
    .select('student_sheet_id, students(name, package_type, status)')
    .eq('email', target);
  if (gErr) throw new Error(`guardian lookup failed: ${gErr.message}`);

  const matches = (guardRows || []).filter(
    (g) => g.students && g.students.status === 'active' &&
      (!knownStudentName || String(g.students.name ?? '').trim() === knownStudentName)
  );
  const match = matches[0] ?? null;

  let studentName = knownStudentName || match?.students?.name || null;
  const packageType = match?.students?.package_type || '';
  let studentNameStatus = studentName ? 'matched' : 'unknown';

  // The FK this request will be filed under. The caller's verified child wins.
  const pcSheetId = knownSheetId || match?.student_sheet_id || null;

  // ── 2. This parent's prior requests (was ParentCheckins!A:H) ─────────────
  const { data: priorRows, error: pErr } = await sb
    .from(PARENT_CHECKINS)
    .select('submitted_at, urgency, payload')
    .eq('parent_email', target)
    .order('submitted_at', { ascending: false });
  if (pErr) throw new Error(`parent_checkins history read failed: ${pErr.message}`);
  const priorRequests = priorRows || [];

  // ── 3. Calculate days since last non-email request ───────────────────────
  const daysSinceLastRequest = calcDaysSinceLastRequest(priorRequests);

  // ── 4. Build context for Claude ──────────────────────────────────────────
  const today = new Date();
  const todayStr = today.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });

  // priorRequests is already this parent's rows, so the email filter is implicit.
  const alreadyHadMeetingThisMonth = priorRequests.some((r) => {
    if (!r.submitted_at || r.urgency === 'Email only') return false;
    const rowDate = new Date(r.submitted_at);
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
${URGENCY_LEVELS.map((l) => `- "${l}"`).join('\n')}

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
  //   'matched'  — email hit the master sheet (or the portal verified the child)
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

  // ── 6. Record the request. ONE store: `parent_checkins`. ────────────────
  // Was an append to MASTER ParentCheckins!A:H, with this upsert as a best-effort
  // mirror whose failure was only console.warn'd. Inverted: this is the record and
  // it FAILS THE REQUEST, because a swallowed error now loses a parent's meeting
  // request outright.
  //
  // sheetSafe() is gone with the tab. It mattered a great deal there — col B is
  // unverified input from an ANONYMOUS internet POST (the public path) and C–H are
  // model-authored off that same input, all landing under USER_ENTERED where a
  // leading "=" becomes a live formula. Parameterized SQL has no such hazard.
  //
  // An unresolved student_sheet_id used to skip the mirror with a warning and leave
  // the row in the sheet only — the "unmatched-parent submissions are skipped"
  // residual noted in lib/supabase.js. There is no sheet to fall back to now, so it
  // is a 400 and the caller is told, rather than a request that silently evaporates.
  if (!pcSheetId) {
    throw new Error(
      `parent check-in from ${target} could not be matched to a student — no guardian row, and no verified child supplied.`
    );
  }

  const orNull = (v) => { const t = String(v ?? '').trim(); return t || null; };
  const { error: pcErr } = await getSupabaseClient()
    .from(PARENT_CHECKINS)
    .upsert({
      student_sheet_id: pcSheetId,
      parent_email: target || null,
      submitted_at: nowISO,
      urgency: orNull(parsed.urgencyLevel),
      payload: {
        student_name: orNull(studentName),
        purpose: orNull(parsed.purpose),
        deadlines: orNull(parsed.deadlines || 'N/A'),
        days_since_last_request: orNull(daysSinceLastRequest),
        reasoning: orNull(parsed.reasoning),
      },
    }, { onConflict: 'student_sheet_id,parent_email,submitted_at', ignoreDuplicates: true });
  if (pcErr) throw new Error(`parent_checkins write failed: ${pcErr.message}`);

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
    subject: `Parent Meeting Request: ${subjectStudent} — ${safeUrgency(parsed.urgencyLevel)}`,
    text: buildPlainText(emailData),
    html: buildHtmlEmail(emailData),
  });

  return { success: true, studentName, studentNameStatus };
}
