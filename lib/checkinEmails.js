import { buildTransporter } from './studentEmails.js';
import { emailBaseUrl } from './baseUrl.js';

// Where the meeting-approval request goes. Per Ryan's directive this is his
// Sapient address specifically (distinct from the booking/cancel addresses in
// lib/instructors.js, which stay support@/ryan@admissions.partners).
export const RYAN_APPROVAL_EMAIL = 'ryan@sapientacademy.com';

function baseUrl() {
  return emailBaseUrl();
}
function approvalLink(token) {
  return `${baseUrl()}/checkin-approval?t=${encodeURIComponent(token)}`;
}

function btn(href, label, color) {
  return `<a href="${href}" style="display:inline-block;margin:6px 8px 6px 0;padding:12px 20px;border-radius:10px;background:${color};color:#fff;font:600 15px/1 -apple-system,Segoe UI,Roboto,sans-serif;text-decoration:none">${label}</a>`;
}

// Emails Ryan the case for a meeting + three confirm links (each opens a signed
// confirmation page; nothing mutates on click — see /checkin-approval). `tokens`
// holds the per-action signed tokens minted by submitUpdateForm.
export async function sendRyanMeetingRequestEmail({ studentName, reason, suggestedLength, signals, tokens, to = RYAN_APPROVAL_EMAIL, cc }) {
  const transporter = buildTransporter();
  const url15 = approvalLink(tokens.grant15);
  const url30 = approvalLink(tokens.grant30);
  const urlReject = approvalLink(tokens.reject);

  const signalLines = (signals || []).filter(Boolean);
  const lengthHint = suggestedLength === '30min' ? '30-min' : '15-min';

  const html = `
    <div style="max-width:560px;margin:0 auto;font:400 15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#2b2622">
      <p style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#9a8f86;margin:0 0 4px">Summer check-in · meeting request</p>
      <h2 style="margin:0 0 14px;font-size:22px;color:#1f1b18">${studentName}</h2>
      <p style="margin:0 0 14px"><strong>Why a meeting may be warranted:</strong><br>${reason || 'See the check-in signals below.'}</p>
      ${signalLines.length ? `<ul style="margin:0 0 16px;padding-left:18px">${signalLines.map((s) => `<li style="margin:0 0 4px">${s}</li>`).join('')}</ul>` : ''}
      <p style="margin:0 0 6px;color:#6f655d">Claude's suggested length: <strong>${lengthHint}</strong>. You decide — pick a button below.</p>
      <div style="margin:14px 0 6px">
        ${btn(url15, 'Grant 15-min', '#c6613f')}
        ${btn(url30, 'Grant 30-min', '#a24a2e')}
        ${btn(urlReject, 'Reject meeting', '#6f655d')}
      </div>
      <p style="margin:14px 0 0;font-size:12px;color:#9a8f86">Each button opens a one-tap confirmation page. On a grant, ${studentName.split(' ')[0]} (CC parents) gets a booking link. On reject, a written report is generated and no email is sent.</p>
    </div>`;

  const text = `Summer check-in — meeting request for ${studentName}

Why a meeting may be warranted:
${reason || 'See signals below.'}
${signalLines.length ? '\n' + signalLines.map((s) => `- ${s}`).join('\n') + '\n' : ''}
Claude's suggested length: ${lengthHint}. You decide:

Grant 15-min: ${url15}
Grant 30-min: ${url30}
Reject meeting: ${urlReject}

Each link opens a one-tap confirmation page (nothing happens until you confirm).`;

  await transporter.sendMail({
    from: process.env.SMTP_USER,
    to,
    cc: cc || undefined, // normal sends pass no cc; only manual stress-tests CC someone
    subject: `Meeting request — ${studentName} (summer check-in)`,
    text,
    html,
  });
}

// Sent to the student (CC both parents) once a meeting is granted, with the
// booking link. Used by Ryan's check-in approval (defaults to Ryan) AND the admin
// one-off grant tool (passes the chosen instructor). `reason` is an optional line
// that replaces "based on your latest check-in" for an admin-issued one-off. Not
// sent on reject.
export async function sendMeetingGrantedEmail({
  studentEmail,
  parentEmails,
  studentName,
  decision,
  instructorSlug = 'ryan',
  instructorName = 'Ryan',
  reason,
}) {
  const transporter = buildTransporter();
  const mins = parseInt(String(decision).replace(/\D/g, ''), 10) || 15;
  const lengthLabel = mins === 30 ? '30-minute Zoom' : mins === 15 ? '15-minute call' : `${mins}-minute Zoom`;
  const bookingUrl = `${baseUrl()}/meetings/${instructorSlug}`;
  const firstName = (studentName || '').split(' ')[0] || 'there';
  const cc = (parentEmails || []).filter((e) => e && String(e).includes('@'));
  const because = reason ? ` (${reason})` : ' based on your latest check-in';

  const text = `Hi ${firstName},

${instructorName} has set up a ${lengthLabel} with you${because}. Pick a time that works:

${bookingUrl}

See you soon.
— Admissions.Partners`;

  const html = `
    <div style="max-width:520px;margin:0 auto;font:400 15px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#2b2622">
      <p style="margin:0 0 14px">Hi ${firstName},</p>
      <p style="margin:0 0 18px">${instructorName} has set up a <strong>${lengthLabel}</strong> with you${because}. Pick a time that works:</p>
      <p style="margin:0 0 20px"><a href="${bookingUrl}" style="display:inline-block;padding:13px 22px;border-radius:10px;background:#c6613f;color:#fff;font-weight:600;text-decoration:none">Book your meeting →</a></p>
      <p style="margin:0;color:#6f655d">See you soon.<br>— Admissions.Partners</p>
    </div>`;

  await transporter.sendMail({
    from: process.env.SMTP_USER,
    to: studentEmail,
    cc: cc.length ? cc.join(', ') : undefined,
    subject: `${instructorName} set up a meeting with you — book your time`,
    text,
    html,
  });
}

// Notify a student that a STANDING weekly project meeting (solo research, etc.) has
// been set up for them. Links to the deep project-booking URL (?m=project:<id>) — a
// bare /meetings/<teacher> link would NOT resolve the project track. Best-effort.
export async function sendProjectMeetingGrantedEmail({
  studentEmail,
  parentEmails,
  studentName,
  label,
  minutes,
  teacherSlug = 'aaron',
  teacherName = 'Aaron',
  planId,
}) {
  const transporter = buildTransporter();
  const mins = parseInt(String(minutes).replace(/\D/g, ''), 10) || 30;
  const lengthLabel = `${mins}-minute`;
  const bookingUrl = `${baseUrl()}/meetings/${teacherSlug}?m=${encodeURIComponent(`project:${planId}`)}`;
  const firstName = (studentName || '').split(' ')[0] || 'there';
  const cc = (parentEmails || []).filter((e) => e && String(e).includes('@'));
  const what = label || 'project meeting';

  const text = `Hi ${firstName},

${teacherName} has set up a weekly ${lengthLabel} ${what} with you. You can book it each week here:

${bookingUrl}

See you soon.
— Admissions.Partners`;

  const html = `
    <div style="max-width:520px;margin:0 auto;font:400 15px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#2b2622">
      <p style="margin:0 0 14px">Hi ${firstName},</p>
      <p style="margin:0 0 18px">${teacherName} has set up a <strong>weekly ${lengthLabel} ${what}</strong> with you. You can book it each week:</p>
      <p style="margin:0 0 20px"><a href="${bookingUrl}" style="display:inline-block;padding:13px 22px;border-radius:10px;background:#c6613f;color:#fff;font-weight:600;text-decoration:none">Book your project meeting →</a></p>
      <p style="margin:0;color:#6f655d">See you soon.<br>— Admissions.Partners</p>
    </div>`;

  await transporter.sendMail({
    from: process.env.SMTP_USER,
    to: studentEmail,
    cc: cc.length ? cc.join(', ') : undefined,
    subject: `${teacherName} set up a weekly ${what} with you`,
    text,
    html,
  });
}
