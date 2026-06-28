/**
 * reconcileInstructorBlocks.cjs — LIVE-SAFE instructor-blocks sync
 * (Sheets `InstructorBlocks` → Supabase `instructor_blocks`).
 *
 *   node scripts/reconcileInstructorBlocks.cjs            # DRY RUN (read + report)
 *   node scripts/reconcileInstructorBlocks.cjs --write    # insert-missing / update / prune
 *
 * Unlike backfillInstructorBlocks.cjs (which DELETE-ALLs then inserts — briefly
 * emptying the table, fine for a cold backfill but NOT for a cron that runs while
 * the app reads `instructor_blocks` in `on` mode, since blocked days would flicker
 * unblocked), this never empties the table:
 *   (a) read existing rows into a key map,
 *   (b) INSERT only desired rows whose key is absent,
 *   (c) UPDATE reason on matched keys whose reason changed,
 *   (d) DELETE only existing rows whose key is no longer desired (prune by id).
 * Additions happen BEFORE deletes, so a still-blocked day is never momentarily
 * unblocked. The table has no unique constraint; the reconcile cron's lockfile
 * serializes writes, so dup rows can't arise concurrently. Read-only against
 * Sheets. Idempotent.
 *
 * Source VERIFIED against lib/blocks.js range A:G:
 *   A instructor · B startDate · C endDate(→startDate if blank) · D reason
 *   E createdAt · F startTime · G endTime (F/G blank = all-day).
 * A source row is a DATE RANGE → expand [startDate..endDate] inclusive into one
 * per-date row, matching the reader shape (block_date, no end_date). Source col E
 * createdAt is intentionally NOT carried (no consumer reads it; let the DB default
 * created_at=now()). instructor must be 'aaron'/'ryan' (enum); others skipped.
 *
 * Key = instructor|block_date|start|end (times canonicalized to 'HH:mm', NULL→'').
 */
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
const { DateTime } = require('luxon');

const MASTER_SHEET_ID = '1YJK05oU_12wX0qK-vTqJJfaS8eVI7JMzdGP0gVso1G4';
const TAB = 'InstructorBlocks';
const SERIAL_EPOCH = DateTime.fromISO('1899-12-30');
const QUOTA_USER = 'reconcile-instructor-blocks';

function loadEnv() {
  const env = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
  return (k) => {
    const m = env.match(new RegExp('^' + k + '=(.*)$', 'm'));
    return m ? m[1].replace(/^['"]|['"]$/g, '') : null;
  };
}

// serial (days since 1899-12-30) or 'YYYY-MM-DD'/ISO string → 'YYYY-MM-DD' or null
function normDate(v) {
  if (v === '' || v == null) return null;
  if (typeof v === 'number') return SERIAL_EPOCH.plus({ days: Math.round(v) }).toISODate();
  const d = DateTime.fromISO(String(v).trim(), { zone: 'America/Los_Angeles' });
  return d.isValid ? d.toISODate() : null;
}
// serial fraction of day or 'HH:mm' → 'HH:mm' or null
function normTime(v) {
  if (v === '' || v == null) return null;
  if (typeof v === 'number') {
    const min = Math.round(v * 24 * 60);
    return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
  }
  const m = String(v).trim().match(/^(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
}

// Times come back from the sheet as 'HH:mm'|null and from Postgres as 'HH:MM:SS'|
// null — canonicalize both to 'HH:mm'|'' so a desired row and an existing row key
// the same way.
const keyTime = (t) => (t ? String(t).slice(0, 5) : '');
const keyOf = (r) => `${r.instructor}|${r.block_date}|${keyTime(r.start_time)}|${keyTime(r.end_time)}`;

async function main() {
  const WRITE = process.argv.includes('--write');
  const get = loadEnv();
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: get('GOOGLE_SERVICE_ACCOUNT_EMAIL'),
      private_key: get('GOOGLE_PRIVATE_KEY').replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const sb = createClient(get('SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false },
  });

  // Single Master read (no per-student fan-out) — cheap enough to run in --fast.
  const rows =
    (
      await sheets.spreadsheets.values.get({
        spreadsheetId: MASTER_SHEET_ID,
        range: `'${TAB}'!A2:G500`,
        valueRenderOption: 'UNFORMATTED_VALUE',
        quotaUser: QUOTA_USER,
      })
    ).data.values || [];

  // Build the DESIRED per-date row set, expanding each source range inclusive.
  const desired = [];
  const warnings = [];
  rows.forEach((r, i) => {
    const instructor = String(r?.[0] ?? '').trim().toLowerCase();
    const start = normDate(r?.[1]);
    if (!instructor && !start) return; // blank row
    if (instructor !== 'aaron' && instructor !== 'ryan') {
      warnings.push(`row ${i + 2}: bad instructor "${r?.[0]}" — skipped`);
      return;
    }
    if (!start) {
      warnings.push(`row ${i + 2} (${instructor}): unparseable startDate "${r?.[1]}" — skipped`);
      return;
    }
    const end = normDate(r?.[2]) || start;
    const reason = String(r?.[3] ?? '').trim() || null;
    const st = normTime(r?.[5]);
    const et = normTime(r?.[6]);
    let d = DateTime.fromISO(start);
    let last = DateTime.fromISO(end);
    if (last < d) {
      warnings.push(`row ${i + 2} (${instructor}): endDate<startDate — using startDate only`);
      last = d;
    }
    let n = 0;
    while (d <= last && n < 400) {
      desired.push({ instructor, block_date: d.toISODate(), start_time: st, end_time: et, reason });
      d = d.plus({ days: 1 });
      n++;
    }
  });

  // Dedup desired on the natural key (keep LAST — a later sheet row wins).
  const desiredByKey = new Map();
  for (const row of desired) desiredByKey.set(keyOf(row), row);
  const dupCount = desired.length - desiredByKey.size;

  console.log(
    `Resolved ${desiredByKey.size} desired instructor_block date-row(s) from ${rows.length} source row(s)` +
      (dupCount ? ` (${dupCount} duplicate key(s) collapsed)` : '') +
      '.'
  );
  warnings.forEach((w) => console.log(`  ⚠ ${w}`));

  // Read existing rows and index by the same natural key.
  const { data: existing, error: exErr } = await sb
    .from('instructor_blocks')
    .select('id, instructor, block_date, start_time, end_time, reason');
  if (exErr) {
    console.error('instructor_blocks read failed:', exErr.message);
    process.exit(1);
  }
  const existingByKey = new Map();
  for (const row of existing || []) existingByKey.set(keyOf(row), row);

  // Diff: inserts (desired key absent), reason-updates (matched, reason changed),
  // deletes (existing key no longer desired).
  const toInsert = [];
  const toUpdate = []; // { id, reason }
  for (const [key, row] of desiredByKey) {
    const ex = existingByKey.get(key);
    if (!ex) {
      toInsert.push({
        instructor: row.instructor,
        block_date: row.block_date,
        start_time: row.start_time,
        end_time: row.end_time,
        reason: row.reason,
      });
    } else if ((ex.reason ?? '') !== (row.reason ?? '')) {
      toUpdate.push({ id: ex.id, reason: row.reason });
    }
  }
  const toDelete = [];
  for (const [key, row] of existingByKey) {
    if (!desiredByKey.has(key)) toDelete.push(row.id);
  }

  console.log(
    `  → ${toInsert.length} insert, ${toUpdate.length} reason-update, ${toDelete.length} prune ` +
      `(of ${existingByKey.size} existing).`
  );

  if (!WRITE) {
    console.log('\nDRY RUN — re-run with --write to apply.');
    return;
  }

  // (b) INSERT missing rows FIRST so newly-blocked days are covered before any
  // prune runs — the table is never momentarily missing a still-blocked day.
  for (let i = 0; i < toInsert.length; i += 500) {
    const { error } = await sb.from('instructor_blocks').insert(toInsert.slice(i, i + 500));
    if (error) {
      console.error('instructor_blocks insert failed:', error.message);
      process.exit(1);
    }
  }

  // (c) UPDATE reason on matched keys whose reason changed (by id).
  for (const u of toUpdate) {
    const { error } = await sb.from('instructor_blocks').update({ reason: u.reason }).eq('id', u.id);
    if (error) {
      console.error('instructor_blocks reason-update failed:', error.message);
      process.exit(1);
    }
  }

  // (d) DELETE stale rows (no longer in the desired set), by id, in chunks.
  for (let i = 0; i < toDelete.length; i += 500) {
    const { error } = await sb.from('instructor_blocks').delete().in('id', toDelete.slice(i, i + 500));
    if (error) {
      console.error('instructor_blocks prune failed:', error.message);
      process.exit(1);
    }
  }

  console.log(
    `\n✓ Reconciled instructor_blocks (live-safe, no empty-table window): ` +
      `+${toInsert.length} inserted, ~${toUpdate.length} reason-updated, -${toDelete.length} pruned.`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
