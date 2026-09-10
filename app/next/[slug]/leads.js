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
                            it is the state an operator can see.

   THE SLUG IS THE STUDENT'S FIRST NAME, lowercase and ASCII: /next/conor,
   next.admissions.partners/conor. If a second LIVE lead shares a first name, BOTH
   move to first-last (conor-min), so no family's address quietly changes
   meaning while they are holding it.

   Aaron's call, 2026-09-03: "conor-c44061 is not as high-touch as /conor; every
   thing that can be changed should be a choice." The tradeoff is accepted, not
   overlooked, and it is this: a guessable slug exposes the student's first
   name, the price ladder for their grade, and the ability to book or reschedule
   that family's slot. The page shows no email address and no phone number, and
   the one place an address would otherwise appear, the booked state, is masked.
   That is the whole of the exposure and the whole of the mitigation.

   A slug that is no longer live is CLOSED, not deleted: status 'closed' renders
   a quiet notice with a 200, because the family followed a link somebody gave
   them and a 404 would tell them they did something wrong. Only a slug we have
   never heard of 404s. */

const LEADS_DIR = path.join(process.cwd(), 'app', 'next', 'leads');

/* One lowercase ASCII token, or two joined by a hyphen: `conor`, `conor-min`.
   Checked before the slug is ever joined to a path, so a request for
   /next/..%2f..%2fetc%2fpasswd cannot become a file read. */
export const SLUG_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/* Mask an address for display. The booked state is the only place the page
   would otherwise print one, and with a guessable slug that would hand a
   family's email to anyone who typed their child's first name. Enough remains
   for the family to recognise their own address and confirm the invitation went
   to the right one, which is all that view is for. */
export function maskEmail(email) {
  const [user, domain] = String(email || '').split('@');
  if (!user || !domain) return null;
  return `${user.slice(0, 1)}•••@${domain}`;
}
const isDev = process.env.NODE_ENV !== 'production';

function readDiskLead(slug) {
  if (!SLUG_SHAPE.test(slug)) return null;
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

/* MAY THIS ROW'S CALENDAR BE TOUCHED AT ALL? One definition, imported by every
   endpoint that reads or writes Ryan's calendar for a lead, because three
   endpoints each deciding this for themselves is three chances to disagree.
   ─────────────────────────────────────────────────────────────────────────
   Two reasons a row is not bookable.

   LIGHT (2026-09-07 evening, Ryan via Aaron). A light page offers no times, and
   the reason is Ryan's: "if light gets access to the calendar, everyone will
   book for a free 30 min even if they have NO intention of signing up." Taking
   the calendar off the PAGE would not have taken it off the row: the slug is
   the credential and it is a guessable first name, so /api/next/slots and
   /api/next/book would still have answered anybody who typed the address. The
   half hour is withheld at the row, not in the markup.

   NOT ACTIVE. A closed page already renders a quiet notice instead of a
   calendar; its endpoints should say the same thing rather than quietly
   inserting an event on Ryan's real calendar for a lead nobody is working.

   An ABSENT status reads as active, which is exactly how page.js reads it (it
   tests only for 'closed'), so a row written before this field existed keeps
   working. Anything else — 'paused', 'draft', a typo — is refused, because a
   status nobody here recognises is not permission. */
export function isBookable(lead) {
  if (!lead) return false;
  if (lead.mode === 'light') return false;
  /* HEAVY HAS NO CALENDAR EITHER, unless the row asks for one (2026-09-08,
     Aaron relaying Ryan). The reasoning is Ryan's and it is the same one that
     took the calendar off light, one step further along: "parents will ALWAYS
     book a free follow-up if the option is available." A heavy family has
     already been escalated, so a free half hour they book on reflex costs Ryan
     the hour and buys nothing the page has not already told them.

     A BOOLEAN, not a rule, because the exception is real: some escalated
     families should be handed a time, and that is Ryan's call per family rather
     than a property of the mode. `calendar: true` on the row turns it back on
     and everything downstream — the month grid, the sticky bar, /api/next/slots
     and /api/next/book — follows from this one function.

     A row with NO mode is untouched and still bookable, which is Conor's live
     shape: heavy is an opt-in, so the absent case belongs to neither branch. */
  if (lead.mode === 'heavy' && lead.calendar !== true) return false;
  /* A SENT PAGE IS STILL BOOKABLE. The 2026-09-10 freeze is about COPY — what a
     family reads must not change under them — and booking is state, not copy.
     Only an archived page loses its calendar, which is the rule 'closed' always
     carried under its old name. */
  return leadLifecycle(lead) !== 'archived';
}

/* THREE STATES: unsent | sent | archived (Aaron, 2026-09-10).
   ─────────────────────────────────────────────────────────────────────────
   THE RULE. A lead page freezes when it is sent. Until the family has the link
   the page is ours to change; once email one has gone, what they opened is what
   they keep opening — including template-level additions no one seeded onto
   their row. Conor's page went 2026-09-05 and must render exactly as it did.

   ARCHIVED IS 'closed' UNDER ITS NEW NAME, and both spellings resolve here, so
   the quiet-200 notice and the calendar refusal keep working on a row written
   before this existed. 'active' is the other legacy value and it means "not
   sent, not archived" — unsent.

   SENT IS READ FROM TWO PLACES ON PURPOSE. `status: 'sent'` is the vocabulary;
   `sentAt` is the date. Either one alone marks the row sent, because the two
   were written in two passes: production runs whatever main carries, and a row
   flipped to a status main did not yet understand would have taken the booking
   panel off a live family's page in the window before the merge. `sentAt` is
   invisible to that older reader, so it could be written first and safely.
   After the status pass both agree and this reads either. */
export function leadLifecycle(lead) {
  const raw = lead?.status;
  if (raw === 'archived' || raw === 'closed') return 'archived';
  if (raw === 'sent' || lead?.sentAt) return 'sent';
  return 'unsent';
}

/* Record a confirmed booking on the lead's row.

   The booking lives on the SAME row as the page it was made from, so "did this
   family book, and when" is one read of one row rather than a join against the
   calendar. It is also the attribution: the row is keyed by the slug, so the
   lead a booking came from is data we own. That is why nothing in this flow
   carries a UTM any more — the Calendly link builder that used to live here,
   and the utm_source/medium/content it assembled, are gone with it.

   Merged into the existing jsonb rather than replacing it: `data` is the whole
   lead page, and a booking must never be able to overwrite the copy. */
export async function recordLeadBooking(slug, booking) {
  const client = getSupabaseClient();
  const { data: row, error: readErr } = await client
    .from(LEAD_PAGES)
    .select('data')
    .eq('slug', slug)
    .maybeSingle();
  if (readErr) throw new Error(`lead_pages read failed for "${slug}": ${readErr.message}`);
  if (!row) throw new Error(`lead_pages has no row for "${slug}"`);

  const next = { ...row.data, booked: booking };
  const { error } = await client
    .from(LEAD_PAGES)
    .update({
      data: next,
      booked_event_id: booking.event_id,
      booked_start: booking.start,
      booked_at: booking.booked_at,
      updated_at: new Date().toISOString(),
    })
    .eq('slug', slug);
  if (error) throw new Error(`lead_pages booking write failed for "${slug}": ${error.message}`);
  return booking;
}

/* The inverse of recordLeadBooking: put the row back to offering times.

   `data.booked` is DELETED rather than set to null, because the page tests for
   its presence to choose between the picker and the booked panel, and a null
   that is still a key is a booked state with no booking in it.

   Written here beside its opposite, and shared with scripts/cancelNextBooking
   and /api/next/cancel, so the two ways a booking can be undone cannot drift
   into clearing different subsets of the row. */
export async function clearLeadBooking(slug) {
  const client = getSupabaseClient();
  const { data: row, error: readErr } = await client
    .from(LEAD_PAGES)
    .select('data')
    .eq('slug', slug)
    .maybeSingle();
  if (readErr) throw new Error(`lead_pages read failed for "${slug}": ${readErr.message}`);
  if (!row) throw new Error(`lead_pages has no row for "${slug}"`);

  const next = { ...row.data };
  delete next.booked;
  const { error } = await client
    .from(LEAD_PAGES)
    .update({
      data: next,
      booked_event_id: null,
      booked_start: null,
      booked_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('slug', slug);
  if (error) throw new Error(`lead_pages clear failed for "${slug}": ${error.message}`);
}
