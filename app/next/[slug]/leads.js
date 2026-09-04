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
   book.ryanchoice.com/conor. If a second LIVE lead shares a first name, BOTH
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
