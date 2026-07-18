import { buildTransporter } from './studentEmails';

// The "clear window, not an open door" sender.
//
// Outreach that is STRUCTURALLY autonomous: it reads as a machine-generated status
// note (a noreply From), and any reply goes to the monitored, shared support inbox —
// NEVER into a counselor's personal inbox. This is the load-bearing fix for the
// escalation problem: a high-touch parent who replies to an automated nudge must not
// land a thread on Director Ryan. See the plan (autonomous-outreach principle).
//
// Both `from` and `replyTo` are env-overridable so the deploy can adapt to whatever
// the SMTP relay is allowed to send AS, without a code change:
//   OUTREACH_FROM      default 'Admissions Partners <noreply@admissions.partners>'
//                      (fallback if the relay can't send-as noreply@: set it to an
//                       autonomy-signaling display name over the authorized mailbox,
//                       e.g. 'Admissions Partners (automated) <SMTP_USER-address>')
//   OUTREACH_REPLY_TO  default 'support@admissions.partners' (real, monitored, NON-Ryan)
const FROM = process.env.OUTREACH_FROM || 'Admissions Partners <noreply@admissions.partners>';
const REPLY_TO = process.env.OUTREACH_REPLY_TO || 'support@admissions.partners';

export async function sendAutonomousEmail({ to, cc, subject, text, html }) {
  const transporter = buildTransporter();
  return transporter.sendMail({
    from: FROM,
    to,
    cc: cc && cc.length ? cc : undefined,
    replyTo: REPLY_TO,
    subject,
    text,
    html,
    // Reinforce "machine-generated" to well-behaved clients / auto-responders.
    headers: { 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'All' },
  });
}
