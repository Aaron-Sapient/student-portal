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
