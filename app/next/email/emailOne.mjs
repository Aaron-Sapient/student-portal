/**
 * emailOne.mjs — render the first post-consult email for a lead.
 *
 *   node app/next/email/emailOne.mjs conor
 *   node app/next/email/emailOne.mjs aaron --base https://aarons-macbook-pro-1.tail4ab0a5.ts.net/next
 *   node app/next/email/emailOne.mjs conor --out /some/dir
 *
 * The email's only job is to get the page opened. It carries no prices, no
 * attachments, no DocuSign and no third-party booking link, because all of that
 * either lives on the page or belongs in email two (Ryan's two-email ruling,
 * Claude_Services.md section 6). Four sentences and a button.
 *
 * TWO CLOSES, chosen by the row's `mode`. A booking row sends the family to the
 * calendar on their page. A LIGHT row has no calendar to send them to, so the
 * close asks for a reply instead, and four extra lints make sure no booking
 * sentence survives a later edit. Either way the copy itself can come from the
 * row (`email.sentences`), so a household's own acknowledgments survive a
 * re-render rather than being flattened back to the generic four.
 *
 * HTML CONSTRAINTS, all of them because Gmail and Apple Mail are not browsers:
 *   · inline styles only. Gmail strips <style> blocks in many contexts and
 *     removes classes, so anything in a stylesheet is a coin flip.
 *   · the button is a padded anchor inside a table cell, not an image and not a
 *     CSS-only shape. Images are blocked by default in both clients, so an image
 *     button is an invisible button; the table is what makes Outlook honour the
 *     padding.
 *   · a plain-text URL sits under the button. Some clients strip the anchor's
 *     styling entirely and a few strip links from unknown senders, and a family
 *     who cannot see a button can still copy a line.
 *   · no em dashes anywhere (Aaron's global rule for outward prose), no
 *     exclamation points, no web fonts, no background images.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEADS_DIR = path.join(__dirname, '..', 'leads');
const DEFAULT_BASE = 'https://book.ryanchoice.com';
const DEFAULT_OUT = '/Users/aaron/Documents/VS Code/scratchpads/student-portal/wt-next-renders/email';

const args = process.argv.slice(2);
const slug = args.find((a) => !a.startsWith('--'));
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
if (!slug) {
  console.error('Usage: node app/next/email/emailOne.mjs <slug> [--base URL] [--out DIR]');
  process.exit(1);
}

const lead = JSON.parse(fs.readFileSync(path.join(LEADS_DIR, `${slug}.json`), 'utf8'));
const base = flag('base', DEFAULT_BASE).replace(/\/+$/, '');
const outDir = flag('out', DEFAULT_OUT);
const link = `${base}/${slug}`;
const name = lead.student;

/* LIGHT MODE (2026-09-07 evening, Ryan via Aaron).
   ─────────────────────────────────────────────────────────────────────────
   A light row's page offers no calendar, so its email may not offer one either:
   an email that says pick a time, over a page with no times on it, is a broken
   promise the family discovers by clicking. What replaces the booking sentence
   is the escalation Ryan described: the page and the brochures are the offer,
   and a reply is how a family asks for options. His reason for withholding the
   half hour, verbatim: "if light gets access to the calendar, everyone will book
   for a free 30 min even if they have NO intention of signing up."
   The shape does not change: four sentences and one button either way. */
const isLight = lead.mode === 'light';

/* THIS FAMILY'S FOUR SENTENCES, FROM THE ROW.
   The generic four below are a fallback, not the product. Every lead-one that
   has actually been sent carried an acknowledgment only that household is owed
   (a late proposal, a follow-up that went out in the wrong order, a promise
   thirteen days old), and those were hand-written into the drafts and lost on
   every re-render. Carrying them on the row means a re-render reproduces the
   approved copy instead of overwriting it, and the lints below then run over
   the real body rather than over a template nobody sends. */
const rowEmail = lead.email || {};

const DEFAULT_SENTENCES = isLight
  ? [
      'Thank you for your time this week.',
      `I put together a short page for ${name} and for you, with what I heard, and the brochures are on it.`,
      `If you would like us to build options around what we talked about, reply to this email and tell us.`,
      `We put those together by hand, around what you asked for and what fits ${name}.`,
    ]
  : /* Ryan's voice, four sentences, adapted from the creative brief's email one
       (2026-09-03 section 2) with two deliberate cuts: the transit-placement
       sentence, because his contact there is a contact and not a placement, and
       the Calendly link, because the page is the booking surface now. The
       international reassurance also comes out, not because it is untrue but
       because the four sentences are the whole budget and the page says it
       better. */
    [
      'Thank you for your time this week.',
      `I put together a short page for ${name} and for you, with what I heard and what happens next.`,
      `The next step is a second conversation, thirty minutes on Zoom in your morning, where I walk you through the family portal and two or three options built for ${name}.`,
      'Pick a time on the page, and there is nothing to prepare.',
    ];

const SENTENCES = Array.isArray(rowEmail.sentences) && rowEmail.sentences.length
  ? rowEmail.sentences
  : DEFAULT_SENTENCES;

const subject = rowEmail.subject || (isLight ? `${name}'s page` : `Next step for ${name}`);
const buttonLabel = rowEmail.buttonLabel || `Open ${name}'s page`;
/* The grey line a client shows beside the subject. It named the meeting length,
   which is the one thing a light email must not say. */
const preheader =
  rowEmail.preheader ||
  (isLight ? 'What I heard, and what we would put together.' : 'Thirty minutes on Zoom, in your morning.');
/* Last name with honorific, or nothing at all. Never a bare "Hi," (the rule and
   its cases: Claude_Emails.md, "The opener, when in doubt"). */
const salutation = rowEmail.salutation || null;

/* Tokens copied off the pamphlet palette rather than the portal's, because an
   email is a print-adjacent surface and the pamphlet is what the family will see
   next to it. Hex only: no CSS variables survive a mail client. */
const INK = '#1a1814';
const INK_SOFT = '#4a463e';
const INK_FAINT = '#8a8478';
const ACCENT = '#a8492a';
const RULE = '#d8cfbe';
const BG = '#f6f1e8';
const SERIF = "'Iowan Old Style', Georgia, 'Times New Roman', serif";
const SANS = "-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(subject)}</title>
</head>
<body style="margin:0;padding:0;background:${BG};">
<!-- Preheader: the grey line a client shows next to the subject. Hidden in the
     body itself, so it never renders twice. -->
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BG};">
  <tr>
    <td align="center" style="padding:32px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">

${
  salutation
    ? `        <tr><td style="font-family:${SERIF};font-size:17px;line-height:1.6;color:${INK_SOFT};padding-bottom:18px;">
          ${esc(salutation)}
        </td></tr>
`
    : ''
}        <tr><td style="font-family:${SERIF};font-size:17px;line-height:1.6;color:${INK_SOFT};padding-bottom:18px;">
          ${SENTENCES.slice(0, 2).map(esc).join(' ')}
        </td></tr>

        <tr><td style="font-family:${SERIF};font-size:17px;line-height:1.6;color:${INK_SOFT};padding-bottom:28px;">
          ${SENTENCES.slice(2).map(esc).join(' ')}
        </td></tr>

        <!-- The button. A padded anchor inside a table cell: no image (blocked
             by default in Gmail and Apple Mail), no background image, no
             border-radius dependency for legibility. If every style is stripped
             it degrades to an underlined link that still says the right thing. -->
        <tr><td style="padding-bottom:12px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0">
            <tr><td align="center" bgcolor="${ACCENT}" style="border-radius:28px;">
              <a href="${esc(link)}" style="display:inline-block;padding:16px 34px;font-family:${SANS};font-size:16px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:28px;">${esc(buttonLabel)}</a>
            </td></tr>
          </table>
        </td></tr>

        <tr><td style="font-family:${SANS};font-size:13px;line-height:1.5;color:${INK_FAINT};padding-bottom:28px;">
          Or paste this into your browser:<br>
          <a href="${esc(link)}" style="color:${INK_FAINT};text-decoration:underline;">${esc(link)}</a>
        </td></tr>

        <tr><td style="font-family:${SERIF};font-size:17px;line-height:1.6;color:${INK_SOFT};padding-bottom:4px;">Best,</td></tr>
        <tr><td style="font-family:${SERIF};font-size:17px;line-height:1.6;color:${INK};padding-bottom:24px;">Ryan</td></tr>

        <tr><td style="border-top:1px solid ${RULE};padding-top:16px;font-family:${SANS};font-size:12px;line-height:1.6;color:${INK_FAINT};">
          Ryan Choi<br>
          Admissions Partners<br>
          930 Roosevelt, Suite 221&ndash;225, Irvine, CA 92620<br>
          (949) 910-5366
        </td></tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>
`;

const text = `${salutation ? `${salutation}\n\n` : ''}${SENTENCES.slice(0, 2).join(' ')}

${SENTENCES.slice(2).join(' ')}

${buttonLabel}: ${link}

Best,
Ryan

Ryan Choi
Admissions Partners
930 Roosevelt, Suite 221-225, Irvine, CA 92620
(949) 910-5366
`;

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, `${slug}.html`), html);
fs.writeFileSync(path.join(outDir, `${slug}.txt`), text);

/* A lint rather than a claim. Every one of these has been shipped wrong by
   somebody on this project at least once. */
const body = SENTENCES.join(' ');
const checks = [
  ['em dashes', !body.includes('—') && !html.includes('—')],
  ['sentences <= 4', SENTENCES.length <= 4],
  ['no price', !/\$|\d{2},\d{3}/.test(body)],
  ['no DocuSign or payment', !/docusign|payment/i.test(body)],
  ['no Calendly', !/calendly/i.test(html)],
  ['no exclamation', !body.includes('!')],
  ['no images', !/<img/i.test(html)],
  ['link present', html.includes(link)],
];

/* THE LIGHT LINTS, over the WHOLE DOCUMENT and not just the four sentences.
   ─────────────────────────────────────────────────────────────────────────
   The preheader is the reason. It is the grey line a mail client prints beside
   the subject, so it is one of the two things a family reads before opening
   anything, and it sits outside SENTENCES where every existing lint was looking.
   It said "Thirty minutes on Zoom, in your morning." for as long as this script
   has existed. A light email whose body is clean and whose preview line offers a
   meeting is still an email that offers a meeting.

   The link is subtracted first. It is book.ryanchoice.com/<slug>, so a check for
   "book" across the raw html would fail on the one string that has to be there,
   twice. Everything else in the document is prose or markup, and neither may
   offer a time, a calendar, a Zoom or a number of minutes, because the page it
   points at offers none of those. */
if (isLight) {
  const doc = html.split(link).join(' ');
  const clean = (re) => !re.test(body) && !re.test(doc);
  checks.push(
    ['light: no booking language', clean(/\bbook(ing|s|ed)?\b/i)],
    ['light: no calendar', clean(/\bcalendar\b/i)],
    ['light: no Zoom', clean(/\bzoom\b/i)],
    ['light: no meeting length', clean(/\b(30|thirty)[\s-]*min(ute)?s?\b/i)],
    ['light: no "pick a time"', clean(/pick a time/i)],
    ['light: an ask to reply', /\breply\b/i.test(body)]
  );
}
console.log(`subject: ${subject}`);
console.log(`link   : ${link}`);
console.log(`wrote  : ${path.join(outDir, `${slug}.html`)}`);
console.log(`         ${path.join(outDir, `${slug}.txt`)}`);
console.log(`words  : ${body.split(/\s+/).length}`);
for (const [label, ok] of checks) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
if (checks.some(([, ok]) => !ok)) process.exit(1);
