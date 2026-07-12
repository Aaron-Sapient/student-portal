/**
 * backfillStudents.cjs — migration step A backfill of the CENTRAL `students`
 * table (+ `guardians`) from the Master "👩‍🎓 All Data" tab into Supabase
 * (student-hubs). This is the FK root: every other 3NF table FKs to
 * students.student_sheet_id, so it must be a COMPLETE superset (active + NC)
 * before the A.2 ALTER…ADD FOREIGN KEY section can run.
 *
 *   node scripts/backfillStudents.cjs            # DRY RUN (resolve + print, no write)
 *   node scripts/backfillStudents.cjs --write    # upsert students + guardians
 *
 * Column mapping VERIFIED against lib/identity.js / app/api/home-data /
 * lib/parentCheckinCore.js (2026-06-20):
 *   A=0 name · B=1 class ('NC' ⇒ not-counseling) · G=6 portal URL → sheet_id
 *   J=9 student email · K=10 parent email 1 · L=11 parent email 2
 *   AL=37 package type · BC=54 ART eligible ('TRUE') · BD=55 ART booking ts
 *
 * compliance_cap domain (added for the Bucket-A dual-write foundation) —
 * VERIFIED against app/api/developer/checkinCompliance/route.js:95-96,107 and
 * a live cell probe: AY=50 last Ryan check-in · BA=52 last Aaron check-in
 * (both native `Date.toISOString()` instants, already ISO text) · BE=56
 * "Needs Checkin" (boolean; explicit FALSE excludes, blank/TRUE does not).
 *
 * DEFERRED to the per-student pass (N+1 reads of 🔎 Overview, with scores/
 * transcript): students.grade (Overview!C4) and students.drive_folder_url
 * (Overview H2/L2) — left NULL here so this step is a single cached Master read.
 *
 * Read-only against Google. Idempotent: upsert students on student_sheet_id,
 * guardians on (student_sheet_id, ordinal). NC students are kept with
 * status='nc' (soft-deactivated, never deleted).
 */
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');

const MASTER_SHEET_ID = '1YJK05oU_12wX0qK-vTqJJfaS8eVI7JMzdGP0gVso1G4';
const MASTER_TAB = "'👩‍🎓 All Data'";

// Exact enum domain (matches the package_type enum + the live Master col AL 1:1).
const PACKAGE_ENUM = new Set(['Essential', 'Comprehensive', 'VIP', 'UVIP']);

function loadEnv() {
  const env = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
  return (k) => {
    const m = env.match(new RegExp('^' + k + '=(.*)$', 'm'));
    return m ? m[1].replace(/^['"]|['"]$/g, '') : null;
  };
}

const sheetIdFromPortalUrl = (url) => {
  const m = String(url ?? '').match(/\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : null;
};
const isNCrow = (r) => String(r?.[1] ?? '').trim().toUpperCase() === 'NC';
const cleanEmail = (v) => String(v ?? '').trim().toLowerCase();
const tsOrNull = (v) => {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d) ? null : d.toISOString();
};
const boolOrNull = (v) => {
  if (v === true || v === false) return v;
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'true') return true;
  if (s === 'false') return false;
  return null;
};

async function main() {
  const WRITE = process.argv.includes('--write');
  // --reconcile (implies --write semantics for the deactivate step): soft-deactivate
  // students that have DISAPPEARED from the Master sheet entirely (status='nc'),
  // never delete — preserves FK'd history. Used by the reconcile cron.
  const RECONCILE = process.argv.includes('--reconcile');
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

  const rows =
    (
      await sheets.spreadsheets.values.get({
        spreadsheetId: MASTER_SHEET_ID,
        range: `${MASTER_TAB}!A:BE`,
        valueRenderOption: 'UNFORMATTED_VALUE',
      })
    ).data.values || [];

  const students = [];
  const guardians = [];
  const warnings = [];
  const skipped = [];
  const seen = new Map(); // sheet_id -> name (dup detection)

  rows.forEach((r, i) => {
    const rowNo = i + 1;
    const name = String(r?.[0] ?? '').trim();
    if (!name) return; // blank/header row
    if (/^name$/i.test(name)) return; // header

    const sheetId = sheetIdFromPortalUrl(r?.[6]);
    if (!sheetId) {
      // No usable portal URL ⇒ can't be served as a portal student (same rule
      // identity.js applies). Record so the count is auditable.
      skipped.push(`row ${rowNo} "${name}": no sheet_id (col G="${String(r?.[6] ?? '').slice(0, 40)}")`);
      return;
    }
    if (seen.has(sheetId)) {
      warnings.push(`DUP sheet_id ${sheetId}: "${seen.get(sheetId)}" and "${name}" (row ${rowNo}) — keeping first`);
      return;
    }
    seen.set(sheetId, name);

    const nc = isNCrow(r);
    const rawPkg = String(r?.[37] ?? '').trim();
    let pkg = rawPkg || null;
    if (pkg && !PACKAGE_ENUM.has(pkg)) {
      warnings.push(`row ${rowNo} "${name}": unknown package "${rawPkg}" → NULL`);
      pkg = null;
    }

    students.push({
      student_sheet_id: sheetId,
      name,
      class: nc ? null : (String(r?.[1] ?? '').trim() || null),
      // grade (Overview!C4) is OMITTED on purpose — mirrorStudentHub owns it; listing
      // it here (even as null) would clobber that write every fast-tier reconcile.
      student_email: cleanEmail(r?.[9]) || null,
      portal_url: String(r?.[6] ?? '').trim() || null,
      drive_folder_url: null, // deferred (Overview H2/L2)
      package_type: pkg,
      gender: String(r?.[49] ?? '').trim() || null, // 👩‍🎓 All Data col AX (idx 49)
      art_eligible: r?.[54] === 'TRUE' || r?.[54] === true,
      needs_checkin: boolOrNull(r?.[56]), // col BE (idx 56)
      last_ryan_checkin: tsOrNull(r?.[50]), // col AY (idx 50)
      last_aaron_checkin: tsOrNull(r?.[52]), // col BA (idx 52)
      status: nc ? 'nc' : 'active',
      updated_at: new Date().toISOString(),
    });

    [
      [10, 1],
      [11, 2],
    ].forEach(([idx, ordinal]) => {
      const email = cleanEmail(r?.[idx]);
      if (email && email.includes('@')) {
        guardians.push({ student_sheet_id: sheetId, email, ordinal });
      }
    });
  });

  const active = students.filter((s) => s.status === 'active').length;
  const nc = students.length - active;
  const withPkg = students.filter((s) => s.package_type).length;
  const artCt = students.filter((s) => s.art_eligible).length;

  console.log(`Resolved ${students.length} students (${active} active, ${nc} NC), ${guardians.length} guardians.`);
  console.log(`  package_type set: ${withPkg} · ART eligible: ${artCt} · skipped (no sheet_id): ${skipped.length}`);
  console.log('\nSample (first 8):');
  students.slice(0, 8).forEach((s) => {
    const g = guardians.filter((x) => x.student_sheet_id === s.student_sheet_id).map((x) => x.email);
    console.log(
      `  ${s.status === 'nc' ? '○' : '✓'} ${s.name.padEnd(22)} class=${String(s.class).padEnd(6)} pkg=${String(s.package_type).padEnd(13)} art=${s.art_eligible ? 'Y' : 'n'}  ${s.student_email || '(no email)'}  parents:[${g.join(', ')}]`
    );
  });
  if (skipped.length) {
    console.log(`\nSkipped ${skipped.length} (no portal sheet_id):`);
    skipped.slice(0, 20).forEach((s) => console.log(`  – ${s}`));
  }
  if (warnings.length) {
    console.log(`\n⚠ ${warnings.length} warning(s):`);
    warnings.forEach((w) => console.log(`  ⚠ ${w}`));
  }

  if (!WRITE) {
    console.log(`\nDRY RUN — re-run with --write to upsert.`);
    return;
  }

  const { error: sErr } = await sb.from('students').upsert(students, { onConflict: 'student_sheet_id' });
  if (sErr) {
    console.error('students upsert failed:', sErr.message);
    process.exit(1);
  }
  console.log(`\n✓ Upserted ${students.length} students.`);

  // guardians: unique(student_sheet_id, ordinal) makes this idempotent. (Removal
  // of a parent email is a reconciliation-cron concern, not handled here.)
  const { error: gErr } = await sb.from('guardians').upsert(guardians, { onConflict: 'student_sheet_id,ordinal' });
  if (gErr) {
    console.error('guardians upsert failed:', gErr.message);
    process.exit(1);
  }
  console.log(`✓ Upserted ${guardians.length} guardians.`);

  // Soft-deactivate students removed from the Master sheet between runs. NC rows
  // still IN the sheet were upserted with status='nc' above; this only catches
  // sheetIds no longer present at all. NEVER deletes (FK'd history stays intact).
  if (RECONCILE) {
    const present = new Set(students.map((s) => s.student_sheet_id));
    const { data: existing, error: exErr } = await sb.from('students').select('student_sheet_id, status');
    if (exErr) {
      console.error('reconcile read failed:', exErr.message);
      process.exit(1);
    }
    const stale = (existing || []).filter((r) => !present.has(r.student_sheet_id) && r.status !== 'nc');
    if (stale.length) {
      const ids = stale.map((r) => r.student_sheet_id);
      const { error: dErr } = await sb.from('students').update({ status: 'nc' }).in('student_sheet_id', ids);
      if (dErr) {
        console.error('soft-deactivate failed:', dErr.message);
        process.exit(1);
      }
      console.log(`✓ Soft-deactivated ${stale.length} student(s) gone from Master: ${ids.join(', ')}`);
    } else {
      console.log('✓ Reconcile: no removed students to deactivate.');
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
