import fs from 'node:fs';
import path from 'node:path';
import { LEAD_PAGES, getSupabaseClient } from '@/lib/supabase';

/* Where a lead page's data comes from.
   ─────────────────────────────────────────────────────────────────────────
   Supabase, read per request with the service-role client the app already
   uses (lib/supabase.js getSupabaseClient — there is exactly one server-side
   client in this repo and this is it). On-disk JSON is a DEVELOPMENT fallback
   and nothing else.

   Why not the filesystem, which is where this started: a lead file carries a
   minor's first name, a parent's email address and phone number, and the
   answers they typed into an intake form, and THIS REPOSITORY IS PUBLIC. The
   files are gitignored for the same reason the proposal generator's records
   are. Vercel builds from git, so a gitignored file is absent at build time and
   the page would not exist in production. The row is the home; the files are
   now just a local convenience and the seed script's input.

   Why per request rather than at build: a new family is an INSERT. No rebuild,
   no deploy, no waiting on a pipeline to put a page in front of someone Ryan
   just spoke to.

   THE THREE OUTCOMES, kept distinct on purpose:

     row found            → render it.
     table reachable,
       no such row        → null, and the route 404s. This is an ANSWER, not a
                            failure, so it must NOT fall through to disk: a
                            deleted row silently resurrected from a stale local
                            file is exactly how a family reads a page someone
                            meant to retract.
     table unreachable    → in development, fall back to disk so the page can be
                            worked on with no database at all. In production,
                            THROW. A 404 there would tell a family their page
                            does not exist, which is both false and something
                            they cannot act on; an error is at least honest and
                            it is the state an operator can see. */

const LEADS_DIR = path.join(process.cwd(), 'app', 'next', 'leads');
const isDev = process.env.NODE_ENV !== 'production';

function readDiskLead(slug) {
  /* The slug reaches the filesystem, so it is checked against the exact shape a
     slug can take before it is ever joined to a path. Without this a request for
     /next/..%2f..%2fetc%2fpasswd would be a file read. */
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(LEADS_DIR, `${slug}.json`), 'utf8'));
  } catch {
    return null;
  }
}

export async function getLead(slug) {
  if (typeof slug !== 'string' || !slug) return null;

  let client;
  try {
    client = getSupabaseClient();
  } catch (err) {
    /* Not configured at all (no SUPABASE_URL / SERVICE_ROLE_KEY). Treated as
       unreachable, which is what it is. */
    if (isDev) return readDiskLead(slug);
    throw err;
  }

  const { data, error } = await client
    .from(LEAD_PAGES)
    .select('data')
    .eq('slug', slug)
    .maybeSingle();

  if (error) {
    if (isDev) return readDiskLead(slug);
    throw new Error(`lead_pages read failed for "${slug}": ${error.message}`);
  }

  /* maybeSingle returns null data for "no such row" and does NOT set error, so
     this branch is the reachable-but-absent case: a real 404, no disk fallback. */
  return data?.data ?? null;
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
   set someone has actually read. The first lead's were checked against the live
   event on 2026-09-03 (GET /event_types, event 88554dee: "Consultation", 30
   minutes, four custom questions, grade level a single-select whose options
   include the exact string "10th"). A lead whose event has a different question
   order must have its own prefill checked the same way, or leave a1..a4 out: a
   positional answer against an unread question set files the phone number under
   whatever question happens to be first.

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
