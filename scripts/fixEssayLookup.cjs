/**
 * fixEssayLookup.cjs — "College List owns essays" sheet fix.
 *
 * Problem: essay rows (e.g. "CA Main Essay") were parked in 🏆 Comps & Projects
 * only so 📆 Meetings!H could VLOOKUP a % by project name. Essay progress was
 * double-entered (C&P col I vs 🏫 College List "Progress Tracker" table) and the
 * essay leaked into the portal's Projects list.
 *
 * Fix, per sheet:
 *   1. Every live formula in Meetings!H that VLOOKUPs into C&P gains a fallback
 *      lookup into the College List Progress_Tracker table (Task → %):
 *      =IFERROR(VLOOKUP($D<r>,'🏆 Comps & Projects'!$E:$L,5,FALSE),
 *               IFERROR(VLOOKUP($D<r>,Progress_Tracker[[Task]:[%]],3,FALSE),""))
 *      (Static/pasted H values — historical snapshots — are left untouched.)
 *   2. Rows in C&P whose key (col E) matches a Progress Tracker Task (e.g.
 *      "CA Main Essay") are DELETED — the College List is the single source.
 *
 * SAFE BY DEFAULT: dry-run unless --commit. Targets the TEST STUDENT unless a
 * sheet id is passed as the first arg. NEVER point --commit at a real student
 * sheet until verified on the test student.
 *
 *   node scripts/fixEssayLookup.cjs                 # dry-run, test student
 *   node scripts/fixEssayLookup.cjs --commit        # apply to test student
 *   node scripts/fixEssayLookup.cjs <SHEET_ID> --commit
 */
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const TEST_STUDENT = '1UW-RSqv30c_BUdv9nfm48YVVs7L-UmWKsYn_jXhYt6w'; // Test2 Student2
const MEETINGS_TAB = '📆 Meetings';
const CP_TAB = '🏆 Comps & Projects';
const COLLEGE_TAB = '🏫 College List';

const args = process.argv.slice(2);
const COMMIT = args.includes('--commit');
const SHEET_ID = args.find((a) => !a.startsWith('--')) || TEST_STUDENT;

function envGet(key) {
  const env = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
  const m = env.match(new RegExp('^' + key + '=(.*)$', 'm'));
  return m ? m[1].replace(/^['"]|['"]$/g, '') : null;
}

function newFormula(row1based) {
  return (
    `=IFERROR(VLOOKUP($D${row1based},'${CP_TAB}'!$E:$L,5,FALSE),` +
    `IFERROR(VLOOKUP($D${row1based},Progress_Tracker[[Task]:[%]],3,FALSE),""))`
  );
}

async function main() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: envGet('GOOGLE_SERVICE_ACCOUNT_EMAIL'),
      private_key: envGet('GOOGLE_PRIVATE_KEY').replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  console.log(`${COMMIT ? 'COMMIT' : 'DRY-RUN'} on sheet ${SHEET_ID}`);

  // Sheet ids for batchUpdate requests.
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: SHEET_ID,
    fields: 'sheets(properties(sheetId,title))',
  });
  const sheetIdOf = {};
  for (const s of meta.data.sheets) sheetIdOf[s.properties.title] = s.properties.sheetId;
  if (sheetIdOf[CP_TAB] === undefined || sheetIdOf[MEETINGS_TAB] === undefined) {
    throw new Error('Missing required tabs');
  }
  if (sheetIdOf[COLLEGE_TAB] === undefined) {
    console.log('No 🏫 College List tab — nothing to fix (not a senior sheet).');
    return;
  }

  // 1. Find live VLOOKUP formulas in Meetings!H.
  const hRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `'${MEETINGS_TAB}'!H1:H400`,
    valueRenderOption: 'FORMULA',
  });
  const hRows = hRes.data.values || [];
  const formulaRows = []; // 1-based sheet row numbers
  hRows.forEach((r, i) => {
    const v = r[0];
    if (typeof v === 'string' && /^=.*vlookup\(.*Comps & Projects/is.test(v)) {
      // Skip any formula that already has the Progress_Tracker fallback.
      if (!/Progress_Tracker/.test(v)) formulaRows.push(i + 1);
    }
  });
  console.log(
    `Meetings!H live C&P-lookup formulas to upgrade: ${formulaRows.length}` +
      (formulaRows.length ? ` (rows ${formulaRows.join(', ')})` : '')
  );
  formulaRows.forEach((r) => console.log(`  H${r} → ${newFormula(r)}`));

  // 2. Find C&P rows whose key (col E) matches a Progress Tracker task.
  const [cpRes, taskRes] = await Promise.all([
    sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `'${CP_TAB}'!E1:E200`,
    }),
    sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `'${COLLEGE_TAB}'!B6:B9`, // Progress Tracker Task column
    }),
  ]);
  const tasks = (taskRes.data.values || []).flat().filter(Boolean);
  const taskSet = new Set(tasks.map((t) => t.trim().toLowerCase()));
  console.log(`Progress Tracker tasks: ${tasks.join(' | ')}`);

  const deleteRows = []; // 0-based grid indices, for deleteDimension
  (cpRes.data.values || []).forEach((r, i) => {
    const key = (r[0] || '').trim().toLowerCase();
    if (key && key !== 'task' && taskSet.has(key)) deleteRows.push(i);
  });
  console.log(
    `C&P rows to delete (essay rows mirrored from Progress Tracker): ${deleteRows.length}` +
      (deleteRows.length ? ` (sheet rows ${deleteRows.map((i) => i + 1).join(', ')})` : '')
  );

  if (!COMMIT) {
    console.log('\nDry-run only. Re-run with --commit to apply.');
    return;
  }

  // Apply: formulas first (values.update), then row deletions (bottom-up).
  for (const r of formulaRows) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `'${MEETINGS_TAB}'!H${r}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[newFormula(r)]] },
    });
    console.log(`Updated Meetings!H${r}`);
  }

  if (deleteRows.length) {
    const requests = deleteRows
      .sort((a, b) => b - a) // bottom-up so indices stay valid
      .map((idx) => ({
        deleteDimension: {
          range: {
            sheetId: sheetIdOf[CP_TAB],
            dimension: 'ROWS',
            startIndex: idx,
            endIndex: idx + 1,
          },
        },
      }));
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests },
    });
    console.log(`Deleted ${deleteRows.length} C&P row(s).`);
  }

  // Verify: re-read the upgraded H cells + confirm keys gone from C&P.
  if (formulaRows.length) {
    const check = await sheets.spreadsheets.values.batchGet({
      spreadsheetId: SHEET_ID,
      ranges: formulaRows.map((r) => `'${MEETINGS_TAB}'!H${r}`),
    });
    check.data.valueRanges.forEach((vr, i) =>
      console.log(`Verify H${formulaRows[i]} = ${JSON.stringify(vr.values?.[0]?.[0])}`)
    );
  }
  const cpAfter = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `'${CP_TAB}'!E1:E200`,
  });
  const leftover = (cpAfter.data.values || [])
    .flat()
    .filter((v) => v && taskSet.has(v.trim().toLowerCase()));
  console.log(leftover.length ? `⚠️ Still present in C&P: ${leftover}` : 'C&P clean ✓');
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
