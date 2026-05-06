import nodemailer from 'nodemailer';

function buildTransporter() {
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

export async function sendStudentRescheduleEmail({ to, studentName, instructorName, oldStart, newStart }) {
  const transporter = buildTransporter();
  const oldLabel = formatPacific(oldStart);
  const newLabel = formatPacific(newStart);
  await transporter.sendMail({
    from: process.env.SMTP_USER,
    to,
    subject: `Your meeting with ${instructorName} has been rescheduled`,
    text: `Hi ${studentName?.split(' ')[0] || ''},\n\nYour meeting with ${instructorName} has been rescheduled.\n\nOld time: ${oldLabel} (Pacific)\nNew time: ${newLabel} (Pacific)\n\nThe Zoom link in the calendar invite is unchanged. If this new time doesn't work, reply to this email or cancel and rebook from your dashboard.\n\n— Admissions.Partners`,
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

export async function sendCheckinReminderEmail({ to, studentName, bcc }) {
  const transporter = buildTransporter();
  const dashboardUrl = `${process.env.NEXT_PUBLIC_BASE_URL || ''}/dashboard`;
  await transporter.sendMail({
    from: process.env.SMTP_USER,
    to,
    bcc, // string or string[]
    subject: 'Reminder: please fill out your weekly check-in',
    text: `Hi ${studentName?.split(' ')[0] || ''},\n\nWe haven't seen a weekly check-in from you in the past 14 days. Please take a few minutes to fill it out — it's how we know what to focus on with you and whether to schedule a meeting this week.\n\nYou can fill out the check-in here: ${dashboardUrl}\n\nThanks,\n— Admissions.Partners`,
  });
}
