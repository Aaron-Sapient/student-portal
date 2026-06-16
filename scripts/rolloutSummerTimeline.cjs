/**
 * rolloutSummerTimeline.cjs — idempotent schema rollout for the summer-timeline foundation.
 *
 * Per student sheet it ensures:
 *   1. The "Competitions and Projects" TABLE gains an "Owner" column (col N) as a native
 *      DROPDOWN column (Ryan/Aaron) → renders as a chip, bounded to the table's rows.
 *   2. A 📅 Summer Timeline tab that is itself a native Table: formula-driven, key-matched
 *      to Comps & Projects col E (reorder-safe), with an expected-% curve that interpolates
 *      through up to 5 NAMED checkpoints (blank ones ignored; falls back to a straight line).
 *      In Scope? = checkbox column, Curve = chip dropdown — controls live only in table rows.
 *
 * SAFE BY DEFAULT: dry-run unless --commit. Targets the TEST STUDENT unless a sheet id is
 * given as the first arg. Re-runnable: skips the Owner column if already present; for the
 * timeline it recreates the tab only when the schema doesn't match (so new sheets create
 * fresh, and a schema upgrade is applied cleanly).
 *
 *   node scripts/rolloutSummerTimeline.cjs                 # dry-run, test student
 *   node scripts/rolloutSummerTimeline.cjs --commit        # apply to test student
 *   node scripts/rolloutSummerTimeline.cjs <SHEET_ID> --commit
 *
 * NEVER point --commit at a real student sheet until verified on the test student.
 */
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const TEST_STUDENT = '1UW-RSqv30c_BUdv9nfm48YVVs7L-UmWKsYn_jXhYt6w'; // Test2 Student2
const PROJECTS_TAB = '🏆 Comps & Projects';
const PROJECTS_TABLE = 'Competitions and Projects';
const TIMELINE_TAB = '📅 Summer Timeline';

// Friendly headers. ①–⑤ group each checkpoint's (Milestone, Due, Goal) triple.
const HEADERS = [
  'Project', 'In Scope?', 'Curve', 'Actual %', 'Expected %', 'Delta', 'Status', 'Start', 'Target Date',
  '① Milestone', '① Due', '① Goal', '② Milestone', '② Due', '② Goal', '③ Milestone', '③ Due', '③ Goal',
  '④ Milestone', '④ Due', '④ Goal', '⑤ Milestone', '⑤ Due', '⑤ Goal',
];
// Relative column index → type. Text columns (Project, Status, Milestone names) omit a type.
const BOOLEAN_COLS = [1];
const DROPDOWN_COLS = { 2: ['Linear', 'Custom'] };           // Curve
const PERCENT_COLS = [3, 4, 5, 11, 14, 17, 20, 23];          // Actual, Expected, Delta, ①–⑤ Goal
const DATE_COLS = [7, 8, 10, 13, 16, 19, 22];                // Start, Target, ①–⑤ Due

const P = `'${PROJECTS_TAB}'`;
const I = (col) => `IFERROR(INDEX(${P}!${col}:${col},MATCH($A%R%,${P}!E:E,0)),"")`;
// Expected %: straight line when Curve=Linear; otherwise piecewise-linear through Start(0%),
// any filled checkpoints (Due,Goal), and Target(100%). Blank checkpoints drop out (FILTER),
// so anchors 1-2-3 with 4-5 blank distribute correctly. All %s in the 0–1 domain.
const F_EXPECTED =
  '=IF(OR($H%R%="",$I%R%=""),"",IF($C%R%="Linear",MEDIAN(0,1,(TODAY()-$H%R%)/($I%R%-$H%R%)),' +
  'LET(s,$H%R%,t,$I%R%,' +
  'cand,{s,0;$K%R%,$L%R%;$N%R%,$O%R%;$Q%R%,$R%R%;$T%R%,$U%R%;$W%R%,$X%R%;t,1},' +
  'f,FILTER(cand,INDEX(cand,,1)<>""),srt,SORT(f,1,TRUE),dts,INDEX(srt,,1),pcs,INDEX(srt,,2),' +
  'n,ROWS(srt),xc,MEDIAN(s,t,TODAY()),k,MIN(MAX(SUMPRODUCT(--(dts<=xc)),1),n-1),' +
  'xlo,INDEX(dts,k),xhi,INDEX(dts,k+1),ylo,INDEX(pcs,k),yhi,INDEX(pcs,k+1),' +
  'IF(xhi=xlo,yhi,ylo+(yhi-ylo)*(xc-xlo)/(xhi-xlo)))))';

function timelineRow(key, r) {
  const fill = (s) => s.replace(/%R%/g, r);
  return [
    key, '', 'Linear',                                  // A Project, B In Scope?, C Curve
    fill('=' + I('I')),                                 // D Actual % (← C&P col I)
    fill(F_EXPECTED),                                   // E Expected %
    fill('=IF(OR($D%R%="",$E%R%=""),"",$D%R%-$E%R%)'),  // F Delta
    fill('=IF($F%R%="","",IF($F%R%>=-0.05,"On Track",IF($F%R%>=-0.15,"Watch","Behind")))'), // G Status
    fill('=' + I('F')),                                 // H Start (← C&P col F)
    fill('=' + I('G')),                                 // I Target Date (← C&P col G "End")
    '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', // J–X: 5 × (Milestone, Due, Goal), blank
  ];
}

function columnProperties() {
  return HEADERS.map((name, i) => {
    const c = { columnIndex: i, columnName: name };
    if (BOOLEAN_COLS.includes(i)) c.columnType = 'BOOLEAN';
    else if (DROPDOWN_COLS[i]) {
      c.columnType = 'DROPDOWN';
      c.dataValidationRule = { condition: { type: 'ONE_OF_LIST', values: DROPDOWN_COLS[i].map(v => ({ userEnteredValue: v })) } };
    } else if (PERCENT_COLS.includes(i)) c.columnType = 'PERCENT';
    else if (DATE_COLS.includes(i)) c.columnType = 'DATE';
    return c;
  });
}

function loadEnv() {
  const env = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
  return k => { const m = env.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].replace(/^['"]|['"]$/g, '') : null; };
}

async function main() {
  const get = loadEnv();
  const auth = new google.auth.GoogleAuth({
    credentials: { client_email: get('GOOGLE_SERVICE_ACCOUNT_EMAIL'), private_key: get('GOOGLE_PRIVATE_KEY').replace(/\\n/g, '\n') },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const args = process.argv.slice(2);
  const COMMIT = args.includes('--commit');
  const SHEET_ID = args.find(a => !a.startsWith('--')) || TEST_STUDENT;
  const log = (...a) => console.log((COMMIT ? '[commit]' : '[dry-run]'), ...a);
  const batch = (requests) => COMMIT && requests.length ? sheets.spreadsheets.batchUpdate({ spreadsheetId: SHEET_ID, requestBody: { requests } }) : null;

  console.log(`\n=== Summer-Timeline rollout → ${SHEET_ID} ${SHEET_ID === TEST_STUDENT ? '(TEST STUDENT)' : '⚠️ NON-TEST SHEET'} ===`);

  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID, fields: 'sheets(properties(sheetId,title),tables(tableId,name,range,columnProperties))' });
  const tabs = {};
  meta.data.sheets.forEach(s => (tabs[s.properties.title] = s));
  const projTab = tabs[PROJECTS_TAB];
  if (!projTab) throw new Error(`Missing "${PROJECTS_TAB}" tab`);

  // ---- 1. Owner column on the Competitions and Projects table ----
  const tbl = (projTab.tables || []).find(t => t.name === PROJECTS_TABLE);
  if (!tbl) throw new Error(`Missing "${PROJECTS_TABLE}" table`);
  const cols = (tbl.columnProperties || []).map((c, i) => ({
    columnIndex: i, columnName: c.columnName,
    ...(c.columnType ? { columnType: c.columnType } : {}),
    ...(c.dataValidationRule ? { dataValidationRule: c.dataValidationRule } : {}),
  }));
  if (cols.some(c => c.columnName === 'Owner')) {
    log(`"${PROJECTS_TABLE}" already has Owner column — skip`);
  } else {
    log(`add Owner (col N) to table "${PROJECTS_TABLE}" as Ryan/Aaron chip dropdown`);
    cols.push({ columnIndex: cols.length, columnName: 'Owner', columnType: 'DROPDOWN', dataValidationRule: { condition: { type: 'ONE_OF_LIST', values: [{ userEnteredValue: 'Ryan' }, { userEnteredValue: 'Aaron' }] } } });
    const ownerCol = tbl.range.startColumnIndex + cols.length - 1; // absolute index of Owner (col N)
    if (COMMIT) {
      await sheets.spreadsheets.values.update({ spreadsheetId: SHEET_ID, range: `${P}!N1`, valueInputOption: 'RAW', requestBody: { values: [['Owner']] } });
    }
    await batch([
      // clear any prior standalone (arrow) validation so only the table chip remains
      { setDataValidation: { range: { sheetId: projTab.properties.sheetId, startRowIndex: 1, endRowIndex: tbl.range.endRowIndex, startColumnIndex: ownerCol, endColumnIndex: ownerCol + 1 } } },
      { updateTable: { table: { tableId: tbl.tableId, range: { ...tbl.range, endColumnIndex: tbl.range.startColumnIndex + cols.length }, columnProperties: cols }, fields: 'range,columnProperties' } },
    ]);
  }

  // ---- 2. 📅 Summer Timeline tab as a native Table ----
  const existing = tabs[TIMELINE_TAB];
  const header0 = existing ? (await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `'${TIMELINE_TAB}'!A1` }).catch(() => ({ data: {} }))).data.values?.[0]?.[0] : null;
  if (existing && header0 !== HEADERS[0]) {
    log(`"${TIMELINE_TAB}" exists with stale schema → delete + recreate`);
    await batch([{ deleteSheet: { sheetId: existing.properties.sheetId } }]);
  } else if (existing) {
    log(`"${TIMELINE_TAB}" already current — leaving as-is`);
    console.log('\nℹ️  nothing to change.\n');
    return;
  }

  // create fresh tab
  let tlId = null;
  log(`create tab "${TIMELINE_TAB}"`);
  if (COMMIT) {
    const res = await sheets.spreadsheets.batchUpdate({ spreadsheetId: SHEET_ID, requestBody: { requests: [{ addSheet: { properties: { title: TIMELINE_TAB, gridProperties: { rowCount: 200, columnCount: HEADERS.length } } } }] } });
    tlId = res.data.replies[0].addSheet.properties.sheetId;
  }

  // header + seeded rows (one per existing project key)
  const keys = ((await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${P}!E2:E` })).data.values || []).map(r => r[0]).filter(k => k && String(k).trim());
  log(`write header + seed ${keys.length} project row(s)`);
  if (COMMIT) {
    const values = [HEADERS, ...keys.map((k, i) => timelineRow(k, i + 2))];
    await sheets.spreadsheets.values.update({ spreadsheetId: SHEET_ID, range: `'${TIMELINE_TAB}'!A1`, valueInputOption: 'USER_ENTERED', requestBody: { values } });
  }

  // wrap as a Table (checkbox / chip dropdown / % / date column types)
  log('convert to Table (In Scope? checkbox, Curve chip, % + date columns)');
  if (COMMIT) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: [{ addTable: { table: { name: 'Summer Timeline', range: { sheetId: tlId, startRowIndex: 0, endRowIndex: 1 + Math.max(keys.length, 1), startColumnIndex: 0, endColumnIndex: HEADERS.length }, columnProperties: columnProperties() } } }] },
    });
  }

  console.log(COMMIT ? '\n✅ committed.\n' : '\nℹ️  dry-run only — re-run with --commit to apply.\n');
}

main().catch(e => { console.error('ROLLOUT ERROR:', e.message); process.exit(1); });
