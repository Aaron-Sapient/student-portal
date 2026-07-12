/**
 * backfillBookingTokens.cjs — mirror the NON-SENIOR meeting-token gate from
 * Master `👩‍🎓 All Data` cols AZ(51)=ryan, BB(53)=aaron, BD(55)=art → Supabase
 * `booking_tokens` (one row per (student, instructor)). Bucket A.
 *
 *   node scripts/backfillBookingTokens.cjs                    # DRY RUN
 *   node scripts/backfillBookingTokens.cjs --write            # upsert present tokens
 *   node scripts/backfillBookingTokens.cjs --reconcile --write # upsert + PRUNE stale rows
 *
 * Source VERIFIED against validateBooking/route.js COLUMN_INDEX, lib/instructors.js:
 *   AZ(51) ryan token: 15min/30min/pending/written/no/'' ; BB(53) aaron token:
 *   15min/30min/email/pending/no/'' ; BD(55) art: an ISO timestamp (or ''). token
 *   'no' = consumed (student booked). ART's ISO instant is stored VERBATIM in
 *   token_value (TEXT) — a timestamptz round-trip would mutate the string the
 *   weekly Saturday-reset comparison depends on (so granted_at is left NULL).
 *
 * SENIORS are EXCLUDED — they use the senior_checkin_grants/senior_bookings
 * ledger, never these columns (fetched from the live `seniors` table to skip).
 * Only rows with a NON-EMPTY token are written (no noise rows for ungated kids).
 *
 * --reconcile adds a live-safe PRUNE pass: any existing mirror row whose (student,
 * instructor) is no longer a present non-empty token (cell cleared, ART cancelled,
 * senior leak, student removed) is deleted, so a cleared cell never leaves a stale
 * grantable token behind. Upsert runs FIRST, prune only touches keys NOT upserted
 * (disjoint sets → never a window where a live token is missing). Idempotent:
 * upsert on (student_sheet_id, instructor).
 */
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');

const MASTER_SHEET_ID = '1YJK05oU_12wX0qK-vTqJJfaS8eVI7JMzdGP0gVso1G4';
const MASTER_TAB = "'👩‍🎓 All Data'";

// slug ← Master column index (0-based). Matches lib/instructors.js masterColumn.
const TOKEN_COLS = [['ryan', 51], ['aaron', 53], ['art', 55]];

function loadEnv() {
  const env = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
  return (k) => { const m = env.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].replace(/^['"]|['"]$/g, '') : null; };
}
const sheetId = (url) => { const m = String(url ?? '').match(/\/d\/([a-zA-Z0-9-_]+)/); return m ? m[1] : null; };

async function main() {
  const WRITE = process.argv.includes('--write');
  const RECONCILE = process.argv.includes('--reconcile');
  const get = loadEnv();
  const auth = new google.auth.GoogleAuth({
    credentials: { client_email: get('GOOGLE_SERVICE_ACCOUNT_EMAIL'), private_key: get('GOOGLE_PRIVATE_KEY').replace(/\\n/g, '\n') },
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const sb = createClient(get('SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });

  // seniors to exclude (table membership = senior, per lib/seniorsCore)
  const { data: seniorRows, error: sErr } = await sb.from('seniors').select('student_sheet_id');
  if (sErr) { console.error('could not read seniors:', sErr.message); process.exit(1); }
  const seniors = new Set((seniorRows || []).map((r) => r.student_sheet_id));

  // T_read: snapshot instant of the authoritative Master read. The prune spares
  // any mirror row written AT OR AFTER this (a live dual-write that landed while
  // this run was in flight) — otherwise a concurrent grant/book could be pruned
  // as "stale" (a fail-open TOCTOU: it'd look re-bookable once a reader exists).
  const readAt = new Date().toISOString();
  const readMs = Date.parse(readAt);
  const rows = (await sheets.spreadsheets.values.get({
    spreadsheetId: MASTER_SHEET_ID, range: `${MASTER_TAB}!A:BD`,
  })).data.values || [];

  const records = [];
  const present = new Set(); // `${id}|${slug}` of every non-empty, non-senior token
  let seniorSkipped = 0;
  rows.forEach((r) => {
    const id = sheetId(r?.[6]);
    if (!id) return;
    if (seniors.has(id)) { seniorSkipped++; return; }
    TOKEN_COLS.forEach(([instructor, idx]) => {
      const token = String(r?.[idx] ?? '').trim();
      if (!token) return;
      present.add(`${id}|${instructor}`);
      records.push({ student_sheet_id: id, instructor, token_value: token, granted_at: null, consumed: token.toLowerCase() === 'no', updated_at: new Date().toISOString() });
    });
  });

  const byVal = {};
  records.forEach((r) => { byVal[`${r.instructor}:${r.token_value}`] = (byVal[`${r.instructor}:${r.token_value}`] || 0) + 1; });
  console.log(`Resolved ${records.length} booking_tokens (${seniorSkipped} senior rows skipped).`);
  console.log(`  distribution: ${JSON.stringify(byVal)}`);

  // A row is prunable only if its key is absent from the fresh snapshot AND it was
  // last written before this run's read (freshness guard — spares concurrent live
  // writes). A null/garbage updated_at → NaN → not pruned (safe).
  const isStale = (e) => !present.has(`${e.student_sheet_id}|${e.instructor}`) && Date.parse(e.updated_at) < readMs;
  // Sanity floor: never mass-prune when the snapshot came back empty but the table
  // isn't (a failed/garbage Master read) — leave the mirror untouched instead.
  const pruneGuardTripped = (existing) => present.size === 0 && (existing || []).length > 0;

  if (!WRITE) {
    if (RECONCILE) {
      const { data: existing } = await sb.from('booking_tokens').select('student_sheet_id,instructor,updated_at');
      if (pruneGuardTripped(existing)) {
        console.log('  [reconcile] prune SKIPPED — empty snapshot vs non-empty table (suspect read).');
      } else {
        console.log(`  [reconcile] would prune ${(existing || []).filter(isStale).length} stale row(s).`);
      }
    }
    console.log('\nDRY RUN — re-run with --write.');
    return;
  }

  const { error } = await sb.from('booking_tokens').upsert(records, { onConflict: 'student_sheet_id,instructor' });
  if (error) { console.error('upsert failed:', error.message); process.exit(1); }
  console.log(`✓ Upserted ${records.length} booking_tokens.`);

  if (RECONCILE) {
    // Prune-by-key: delete any existing row whose (student,instructor) key is no
    // longer a present non-empty token AND that predates this run's read. The upsert
    // ran FIRST and present-keyed rows are never in the prune set, so no live token
    // is momentarily absent. Each delete is additionally guarded by
    // `.lt('updated_at', readAt)` so a dual-write that lands between this SELECT and
    // the DELETE (bumping updated_at to now) is spared atomically at the DB — fully
    // closing the fail-open TOCTOU that a snapshot-only diff would leave open.
    const { data: existing, error: exErr } = await sb.from('booking_tokens').select('student_sheet_id,instructor,updated_at');
    if (exErr) { console.error('reconcile: could not read existing rows:', exErr.message); process.exit(1); }
    if (pruneGuardTripped(existing)) {
      console.warn('reconcile: prune SKIPPED — empty snapshot vs non-empty table (suspect Master read); mirror left untouched.');
    } else {
      const stale = (existing || []).filter(isStale);
      let pruned = 0;
      for (const s of stale) {
        const { data: del, error: dErr } = await sb.from('booking_tokens').delete()
          .eq('student_sheet_id', s.student_sheet_id).eq('instructor', s.instructor)
          .lt('updated_at', readAt)
          .select('id');
        if (dErr) { console.warn(`  prune failed for ${s.student_sheet_id.slice(0, 10)}…/${s.instructor}: ${dErr.message}`); continue; }
        if (del && del.length) pruned++; // 0 rows = a concurrent write bumped updated_at → spared
      }
      console.log(`✓ Pruned ${pruned} stale booking_tokens (of ${stale.length} candidates).`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
