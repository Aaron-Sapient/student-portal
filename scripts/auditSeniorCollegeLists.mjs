/**
 * auditSeniorCollegeLists.mjs — which seniors are MISSING a usable 🏫 College
 * List? Read-only. Born from the "existential" 2026-06-19 incident: a senior
 * (Arsh) had the OLD layout of the College List tab, which the backend couldn't
 * parse — so the portal's college route 404'd and the essays subtab dead-ended.
 *
 *   node scripts/auditSeniorCollegeLists.mjs          # audit every active senior
 *   node scripts/auditSeniorCollegeLists.mjs --json   # machine-readable dump too
 *
 * Per senior it classifies the LIVE sheet (the source of truth, not the mirror):
 *   OK            — the canonical tab is present AND in the recognized format
 *   UNRECOGNIZED  — the tab exists but has NONE of the format's header markers
 *                   (Task / PIQ / # ) → the old layout the parser can't read
 *   NO-TAB        — no tab literally named '🏫 College List' on the sheet
 *   READ-ERROR    — the sheet couldn't be read at all
 * …and cross-checks the Supabase `student_college_lists` mirror the app reads.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';
import { createClient } from '@supabase/supabase-js';
import { parseCollegeGrid } from '../lib/collegeList.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COLLEGE_TAB = '🏫 College List';

function loadEnv() {
  const env = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
  return (k) => {
    const m = env.match(new RegExp('^' + k + '=(.*)$', 'm'));
    return m ? m[1].replace(/^['"]|['"]$/g, '') : null;
  };
}

// Same cell/marker reading as lib/collegeList.js, re-derived here so we can detect
// whether the recognized header MARKERS exist (parseCollegeGrid only counts the
// ROWS beneath them, which can't tell "new format but empty" from "old format").
const text = (c) => (c?.formattedValue ?? '').trim();
const findRow = (rows, col, marker) =>
  rows.findIndex((r) => text((r?.values || [])[col]) === marker);

async function main() {
  const get = loadEnv();
  const wantJson = process.argv.includes('--json');

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

  const { data: seniors, error: sErr } = await sb
    .from('seniors')
    .select('student_sheet_id, student_name, student_email, package, primary_teacher, phase')
    .eq('active', true);
  if (sErr) throw sErr;
  seniors.sort((a, b) => (a.student_name || '').localeCompare(b.student_name || ''));

  // The mirror the app actually reads — present? how stale?
  const { data: mirrorRows } = await sb
    .from('student_college_lists')
    .select('student_sheet_id, updated_at');
  const mirror = new Map((mirrorRows || []).map((r) => [r.student_sheet_id, r.updated_at]));

  const results = [];
  for (const s of seniors) {
    const r = {
      name: s.student_name,
      email: s.student_email,
      sheetId: s.student_sheet_id,
      verdict: null,
      schools: 0,
      piqs: 0,
      tasks: 0,
      tabTitles: [],
      mirror: mirror.has(s.student_sheet_id),
      mirrorUpdated: mirror.get(s.student_sheet_id) || null,
      note: '',
    };
    try {
      // 1) Does a tab literally named '🏫 College List' exist? List all titles so
      //    a misnamed/old tab (e.g. plain "College List") is visible to Aaron.
      const meta = await sheets.spreadsheets.get({
        spreadsheetId: s.student_sheet_id,
        fields: 'sheets.properties.title',
      });
      r.tabTitles = (meta.data.sheets || []).map((sh) => sh.properties?.title).filter(Boolean);

      if (!r.tabTitles.includes(COLLEGE_TAB)) {
        r.verdict = 'NO-TAB';
        const near = r.tabTitles.filter((t) => /college|list|school/i.test(t));
        if (near.length) r.note = `closest tabs: ${near.join(', ')}`;
      } else {
        // 2) Read the grid (with chip links) and check for the format's header markers.
        const res = await sheets.spreadsheets.get({
          spreadsheetId: s.student_sheet_id,
          ranges: [`'${COLLEGE_TAB}'!A1:Q60`],
          fields: 'sheets(data(rowData(values(formattedValue,hyperlink,chipRuns))))',
        });
        const rows = res.data.sheets?.[0]?.data?.[0]?.rowData || [];
        const hasMarkers =
          findRow(rows, 1, 'Task') >= 0 ||
          findRow(rows, 1, 'PIQ') >= 0 ||
          findRow(rows, 6, '#') >= 0;
        if (!hasMarkers) {
          r.verdict = 'UNRECOGNIZED';
          r.note = 'tab present but none of the Task/PIQ/# headers found (old layout)';
        } else {
          const g = parseCollegeGrid(rows);
          r.schools = g.schools.length;
          r.piqs = g.piqs.filter((p) => p.chosen).length;
          r.tasks = g.tasks.length;
          r.verdict = 'OK';
          if (!r.schools && !r.tasks && !g.piqs.length) r.note = 'recognized but empty';
        }
      }
    } catch (e) {
      r.verdict = 'READ-ERROR';
      r.note = e.message;
    }
    results.push(r);
  }

  // ── Report ──────────────────────────────────────────────────────────────────
  const ICON = { OK: '✓', UNRECOGNIZED: '⚠', 'NO-TAB': '✗', 'READ-ERROR': '✗' };
  console.log(`\nSenior College List audit — ${results.length} active seniors\n`);
  for (const r of results) {
    const mir = r.mirror ? `mirror ${String(r.mirrorUpdated).slice(0, 10)}` : 'NO mirror';
    const counts = r.verdict === 'OK' ? `${r.schools} schools · ${r.piqs} PIQs` : '';
    console.log(
      `${ICON[r.verdict] || '?'} ${r.verdict.padEnd(12)} ${(r.name || '?').padEnd(22)} ${counts.padEnd(22)} ${mir}`
    );
    if (r.note) console.log(`      ↳ ${r.note}`);
  }

  const by = (v) => results.filter((r) => r.verdict === v);
  const needFix = results.filter((r) => r.verdict !== 'OK');
  console.log(
    `\nSummary: ${by('OK').length} OK · ${by('UNRECOGNIZED').length} unrecognized · ` +
      `${by('NO-TAB').length} no-tab · ${by('READ-ERROR').length} read-error`
  );
  const noMirror = results.filter((r) => !r.mirror);
  if (noMirror.length)
    console.log(`Mirror missing for ${noMirror.length}: ${noMirror.map((r) => r.name).join(', ')}`);
  if (needFix.length) {
    console.log(`\n⚠ Need attention (${needFix.length}):`);
    for (const r of needFix) console.log(`   • ${r.name} (${r.verdict}) — ${r.sheetId}`);
  } else {
    console.log('\nAll seniors have a readable College List. 🎉');
  }

  if (wantJson) console.log('\n' + JSON.stringify(results, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
