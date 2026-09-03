import fs from 'node:fs';
import path from 'node:path';

/* The slug registry.
   ─────────────────────────────────────────────────────────────────────────
   One JSON file per lead in app/next/leads/, read from disk at BUILD time.
   Both callers (generateStaticParams and the page body) are server-only and
   run during the build, so nothing here ships to a browser.

   Why the directory is read rather than each lead being imported by name:
   THIS REPOSITORY IS PUBLIC (github.com/Aaron-Sapient/student-portal). A lead
   file carries a minor's first name, a parent's email address and phone
   number, and the grade and priority they typed into an intake form. That is
   the same class of data the proposal generator's records hold, and those are
   gitignored for exactly this reason. An `import lead from '../leads/<lead>-<hex>'`
   line forces the file into git or breaks the build; reading the directory
   lets the mechanism live in the repo while the families live only on the
   machine that builds the page.

   Consequence worth knowing before any deploy: Vercel builds from git, so a
   gitignored lead file is not present at build and its page will not exist in
   production. Shipping this for real needs a decision about where lead data
   lives (a private path, an env-injected blob, or a Supabase row read at build
   time). That decision is open. Locally, and for review, the files on disk are
   the source and everything works.

   The slug IS the file name, minus .json, and takes the form <lead>-<6 hex>.
   The hex is not decoration: the page carries prices, so an enumerable address
   (/next/<first name>) would hand one family's quote to anyone who guessed a first
   name. Same capability model the /write route already runs on, which is why
   this route is Clerk-public in proxy.js. */

const LEADS_DIR = path.join(process.cwd(), 'app', 'next', 'leads');

function readLeads() {
  let files = [];
  try {
    files = fs.readdirSync(LEADS_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    /* No directory at all is a legitimate state (a clone with no lead files),
       and it must produce zero pages rather than a build failure. */
    return {};
  }
  const out = {};
  for (const f of files) {
    try {
      out[f.replace(/\.json$/, '')] = JSON.parse(fs.readFileSync(path.join(LEADS_DIR, f), 'utf8'));
    } catch {
      /* One malformed file must not take the other families' pages down with
         it. It is skipped, and its slug simply 404s like any unknown one. */
    }
  }
  return out;
}

export const LEADS = readLeads();

export function getLead(slug) {
  return Object.prototype.hasOwnProperty.call(LEADS, slug) ? LEADS[slug] : null;
}

/* The Calendly link, assembled in one place so no surface can build a
   half-tagged variant.

   Parameters verified against Calendly's own help pages on 2026-09-03:
   prefill takes `name`, `first_name`, `last_name`, `email`, `location`,
   `a1`..`a10`, `guests`, with spaces encoded as %20
   (calendly.com/help/how-to-pre-fill-invitee-information-in-your-calendly-link);
   source tracking takes `utm_source`, `utm_medium`, `utm_campaign`,
   `utm_content`, `utm_term`, each value under 255 characters
   (calendly.com/help/how-to-source-track-your-calendly-embed-with-utm-parameters).
   URLSearchParams does the encoding, so a name with a space or an email with an
   @ cannot break the link.

   The a1..a10 answers are POSITIONAL, so they are only safe against a question
   set someone has actually read. The first lead's were checked against the live event on
   2026-09-03 (GET /event_types, event 88554dee: "Consultation", 30 minutes,
   four custom questions, grade level a single-select whose options include the
   exact string "10th"). A lead whose event has a different question order must
   have its own prefill checked the same way, or leave a1..a4 out: a positional
   answer against an unread question set files the phone number under whatever
   question happens to be first.

   utm_content is taken from the lead's `id` rather than typed into the JSON, so
   the tag and the ledger handle cannot drift apart. */
export function bookingUrl(lead, held) {
  const b = lead.booking || {};
  const params = new URLSearchParams({
    ...(b.prefill || {}),
    ...(b.utm || {}),
    utm_content: lead.id,
  });

  /* A held time deep-links into its own slot.

     slotPath is the date-time segment Calendly itself writes into the address
     bar when a slot is selected, copied verbatim rather than composed here, so
     the link is verified by whoever picked the time instead of by my reading of
     a URL format. Probed 2026-09-03: Calendly serves the correct event page for
     a well-formed slot path and 302s a malformed one, so the route is real;
     whether the slot arrives preselected happens in their client and was not
     verified from here. month/date are the weaker fallback: they open the
     calendar on the right day and leave the time to the family. With neither,
     the button is the plain booking link, which still works. */
  if (held?.slotPath) return `${b.url}/${held.slotPath}?${params.toString()}`;
  if (held?.month) params.set('month', held.month);
  if (held?.date) params.set('date', held.date);

  return `${b.url}?${params.toString()}`;
}
