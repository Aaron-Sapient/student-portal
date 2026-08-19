import { buildTransporter } from './studentEmails.js';
import { emailBaseUrl } from './baseUrl.js';

function baseUrl() {
  return emailBaseUrl();
}

// Sent to the student (CC both parents) once a meeting is granted, with the
// booking link. Used by the check-in evaluator's direct grant (defaults to Ryan)
// AND the admin one-off grant tool (passes the chosen instructor). `reason` is an
// optional line that replaces "based on your latest check-in" for an admin-issued
// one-off. Not sent when the check-in routes to a written report.
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
  // Optional companion document, served through the portal (e.g. the student's
  // timeline in their Files tab). When the session exists to walk a document
  // each week, the booking link alone doesn't tell the student what to open.
  docUrl,
  docLabel,
}) {
  const transporter = buildTransporter();
  const mins = parseInt(String(minutes).replace(/\D/g, ''), 10) || 30;
  const lengthLabel = `${mins}-minute`;
  const bookingUrl = `${baseUrl()}/meetings/${teacherSlug}?m=${encodeURIComponent(`project:${planId}`)}`;
  const firstName = (studentName || '').split(' ')[0] || 'there';
  const cc = (parentEmails || []).filter((e) => e && String(e).includes('@'));
  const what = label || 'project meeting';
  const doc = docUrl ? { url: docUrl, label: docLabel || 'your document' } : null;

  const text = `Hi ${firstName},

${teacherName} has set up a weekly ${lengthLabel} ${what} with you. You can book it each week here:

${bookingUrl}
${doc ? `
This is the meeting where we walk ${doc.label}, which now lives in the Files tab of your portal:

${doc.url}
` : ''}
See you soon.
— Admissions.Partners`;

  const html = `
    <div style="max-width:520px;margin:0 auto;font:400 15px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#2b2622">
      <p style="margin:0 0 14px">Hi ${firstName},</p>
      <p style="margin:0 0 18px">${teacherName} has set up a <strong>weekly ${lengthLabel} ${what}</strong> with you. You can book it each week:</p>
      <!-- The button names the session ("Book your ACT Reading"), never "project
           meeting" — the track carries named tutoring now, and a student holding
           several of them can't tell which link this is from a generic label. -->
      <p style="margin:0 0 20px"><a href="${bookingUrl}" style="display:inline-block;padding:13px 22px;border-radius:10px;background:#c6613f;color:#fff;font-weight:600;text-decoration:none">Book your ${what} →</a></p>
      ${doc ? `<p style="margin:0 0 14px">This is the meeting where we walk <strong>${doc.label}</strong>. It now lives in the Files tab of your portal:</p>
      <p style="margin:0 0 20px"><a href="${doc.url}" style="display:inline-block;padding:12px 20px;border-radius:10px;border:1.5px solid #c6613f;color:#c6613f;font-weight:600;text-decoration:none">Open ${doc.label} →</a></p>` : ''}
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
