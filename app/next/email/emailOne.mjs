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

/* Ryan's voice, four sentences, adapted from the creative brief's email one
   (2026-09-03 section 2) with two deliberate cuts: the transit-placement
   sentence, because his contact there is a contact and not a placement, and the
   Calendly link, because the page is the booking surface now. The international
   reassurance also comes out, not because it is untrue but because the four
   sentences are the whole budget and the page says it better. */
const SENTENCES = [
  'Thank you for your time this week.',
  `I put together a short page for ${name} and for you, with what I heard and what happens next.`,
  `The next step is a second conversation, thirty minutes on Zoom in your morning, where I walk you through the family portal and two or three options built for ${name}.`,
  'Pick a time on the page, and there is nothing to prepare.',
];

const subject = `Next step for ${name}`;
const buttonLabel = `Open ${name}'s page`;

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
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">Thirty minutes on Zoom, in your morning.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BG};">
  <tr>
    <td align="center" style="padding:32px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">

        <tr><td style="font-family:${SERIF};font-size:17px;line-height:1.6;color:${INK_SOFT};padding-bottom:18px;">
          ${esc(SENTENCES[0])} ${esc(SENTENCES[1])}
        </td></tr>

        <tr><td style="font-family:${SERIF};font-size:17px;line-height:1.6;color:${INK_SOFT};padding-bottom:28px;">
          ${esc(SENTENCES[2])} ${esc(SENTENCES[3])}
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

const text = `${SENTENCES.join(' ')}

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
console.log(`subject: ${subject}`);
console.log(`link   : ${link}`);
console.log(`wrote  : ${path.join(outDir, `${slug}.html`)}`);
console.log(`         ${path.join(outDir, `${slug}.txt`)}`);
console.log(`words  : ${body.split(/\s+/).length}`);
for (const [label, ok] of checks) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
if (checks.some(([, ok]) => !ok)) process.exit(1);
