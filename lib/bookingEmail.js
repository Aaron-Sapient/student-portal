import nodemailer from 'nodemailer';

/* The booking notification, extracted from app/api/bookMeeting/route.js on
   2026-09-03, unchanged in behaviour.

   It is here because the per-lead page (/next/<slug>) books real meetings on
   Ryan's calendar and support@ has to hear about those the same way it hears
   about a student's booking. One mail, one format, one place: an operations
   inbox that receives two different shapes of "a meeting was booked" is an
   inbox where one of the two eventually stops being read. */
export async function sendBookingEmail(
  instructor,
  studentName,
  studentEmail,
  duration,
  meetingStart,
  agenda,
  isReschedule = false
) {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });

  const dateLabel = new Date(meetingStart).toLocaleString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
    timeZone: 'America/Los_Angeles',
  });

  const action = isReschedule ? 'rescheduled' : 'booked';
  const agendaLine = agenda ? `\nAgenda: ${agenda}` : '';

  // A reschedule used to send TWO mails (bookMeeting → bookingEmail, cancelMeeting →
  // cancelEmail) and those differ for Ryan — support@ vs ryan@. It is one request now,
  // so cancelEmail is added here or Ryan's own inbox would stop hearing about moves.
  const recipients = [studentEmail, instructor.bookingEmail];
  if (isReschedule && instructor.cancelEmail) recipients.push(instructor.cancelEmail);

  await transporter.sendMail({
    from: process.env.SMTP_USER,
    to: [...new Set(recipients.filter(Boolean))].join(', '),
    subject: isReschedule
      ? `Meeting Rescheduled: ${studentName} – ${duration} with ${instructor.displayName}`
      : `New Meeting Booked: ${studentName} – ${duration} with ${instructor.displayName}`,
    text: `Hi,\n\n${studentName} has ${action} a ${duration} meeting with ${instructor.displayName} for ${dateLabel} (Pacific Time).${agendaLine}\n\nZoom: ${instructor.zoomLink}\n\nThis is an automated message from the student portal.`,
  });
}
