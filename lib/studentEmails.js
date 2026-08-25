import nodemailer from 'nodemailer';

export function buildTransporter() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

function formatPacific(iso) {
  return new Date(iso).toLocaleString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
    timeZone: 'America/Los_Angeles',
  });
}

// `notify` — extra recipients (the instructor, normally). Defaults to none, so the admin
// reschedule route's existing call is unchanged: there the instructor IS the actor and
// does not need telling. It is NOT optional for a STUDENT-initiated move — a project
// meeting can now be moved on two hours' notice, and an instructor who isn't told simply
// sits on Zoom at the old time. `byStudent` swaps the copy for that case: the original
// wording ("has been rescheduled … reply if this doesn't work") is written for someone
// who had the change done TO them, which is wrong for the student who just picked it.
export async function sendStudentRescheduleEmail({ to, studentName, instructorName, oldStart, newStart, notify = [], byStudent = false }) {
  const transporter = buildTransporter();
  const oldLabel = formatPacific(oldStart);
  const newLabel = formatPacific(newStart);
  const who = studentName || 'A student';
  // Deduped case-insensitively: for Aaron, cancelEmail and bookingEmail are the same
  // address, so a naive concat would mail him twice for one move.
  const seen = new Set();
  const recipients = [to, ...notify].filter((a) => {
    const k = String(a || '').trim().toLowerCase();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const body = byStudent
    ? `Hi ${studentName?.split(' ')[0] || ''},\n\nYour meeting with ${instructorName} is moved.\n\nWas: ${oldLabel} (Pacific)\nNow: ${newLabel} (Pacific)\n\nThe Zoom link in the calendar invite is unchanged.\n\n— Admissions.Partners`
    : `Hi ${studentName?.split(' ')[0] || ''},\n\nYour meeting with ${instructorName} has been rescheduled.\n\nOld time: ${oldLabel} (Pacific)\nNew time: ${newLabel} (Pacific)\n\nThe Zoom link in the calendar invite is unchanged. If this new time doesn't work, reply to this email or cancel and rebook from your dashboard.\n\n— Admissions.Partners`;
  await transporter.sendMail({
    from: process.env.SMTP_USER,
    to: recipients,
    subject: byStudent
      ? `${who} moved their meeting: ${newLabel} (was ${oldLabel})`
      : `Your meeting with ${instructorName} has been rescheduled`,
    text: body,
  });
}

export async function sendStudentCancellationEmail({ to, studentName, instructorName, meetingStart }) {
  const transporter = buildTransporter();
  const dateLabel = formatPacific(meetingStart);
  await transporter.sendMail({
    from: process.env.SMTP_USER,
    to,
    subject: `Your meeting with ${instructorName} has been cancelled`,
    text: `Hi ${studentName?.split(' ')[0] || ''},\n\nYour meeting with ${instructorName} on ${dateLabel} (Pacific) has been cancelled.\n\nYour booking token has been refunded — you can rebook a new time from your student dashboard whenever you're ready.\n\n— Admissions.Partners`,
  });
}
