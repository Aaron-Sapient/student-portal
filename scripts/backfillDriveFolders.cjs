/**
 * backfillDriveFolders.cjs — fill students.drive_folder_url from each student's
 * '🔎 Overview' tab (H2 primary / L2 fallback), the deferred field from the
 * central backfill. Needs RICH cell fields (hyperlink / text-run link / smart-
 * chip link / plain text), mirroring lib/studentFiles.js extractDriveFolderId.
 *
 *   node scripts/backfillDriveFolders.cjs           # DRY RUN
 *   node scripts/backfillDriveFolders.cjs --write    # update students
 *
 * Stores a canonical https://drive.google.com/drive/folders/<id> URL.
 * Quota-isolated + paced. VERIFIED against studentFiles.js:141-165,195-236.
 */
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');

const QUOTA_USER = 'backfill-drive';
const PACE_MS = 1100;
const LINK_FIELDS = 'sheets(data(rowData(values(formattedValue,hyperlink,textFormatRuns(format(link(uri))),chipRuns(chip(richLinkProperties(uri)))))))';

function loadEnv() {
  const env = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
  return (k) => { const m = env.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].replace(/^['"]|['"]$/g, '') : null; };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function folderIdFrom(cell) {
  if (!cell) return null;
  const uris = [cell.hyperlink, cell.formattedValue];
  for (const run of cell.textFormatRuns || []) if (run?.format?.link?.uri) uris.push(run.format.link.uri);
  for (const chip of cell.chipRuns || []) if (chip?.chip?.richLinkProperties?.uri) uris.push(chip.chip.richLinkProperties.uri);
  for (const u of uris) {
    const s = String(u ?? '');
    const m = s.match(/\/folders\/([a-zA-Z0-9_-]+)/) || s.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (m) return m[1];
  }
  return null;
}

async function main() {
  const WRITE = process.argv.includes('--write');
  const get = loadEnv();
  const auth = new google.auth.GoogleAuth({
    credentials: { client_email: get('GOOGLE_SERVICE_ACCOUNT_EMAIL'), private_key: get('GOOGLE_PRIVATE_KEY').replace(/\\n/g, '\n') },
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const sb = createClient(get('SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });

  const { data: students, error } = await sb.from('students').select('student_sheet_id, name').order('name');
  if (error) { console.error(error.message); process.exit(1); }

  const updates = [];
  const missing = [];
  for (const s of students) {
    let id = null;
    try {
      const res = await sheets.spreadsheets.get({
        spreadsheetId: s.student_sheet_id, ranges: ["'🔎 Overview'!H2", "'🔎 Overview'!L2"], fields: LINK_FIELDS, quotaUser: QUOTA_USER,
      });
      const cellOf = (i) => res.data.sheets?.[i]?.data?.[0]?.rowData?.[0]?.values?.[0];
      id = folderIdFrom(cellOf(0)) || folderIdFrom(cellOf(1));
    } catch (e) { missing.push(`${s.name} (read error: ${e.message})`); }
    if (id) updates.push({ id: s.student_sheet_id, url: `https://drive.google.com/drive/folders/${id}`, name: s.name });
    else if (!missing.find((m) => m.startsWith(s.name))) missing.push(s.name);
    await sleep(PACE_MS);
  }

  console.log(`Resolved ${updates.length}/${students.length} drive folders.`);
  updates.slice(0, 8).forEach((u) => console.log(`  ${u.name.padEnd(22)} ${u.url}`));
  if (missing.length) console.log(`\n⚠ ${missing.length} without a folder link: ${missing.join(', ')}`);

  if (!WRITE) { console.log('\nDRY RUN — re-run with --write.'); return; }
  for (const u of updates) { await sb.from('students').update({ drive_folder_url: u.url }).eq('student_sheet_id', u.id); }
  console.log(`\n✓ Updated ${updates.length} drive_folder_url.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
