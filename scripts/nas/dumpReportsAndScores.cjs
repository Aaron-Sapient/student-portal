/**
 * dumpReportsAndScores.cjs — READ-ONLY audit pull. Dumps every student's
 * Claude-generated parent/student-facing text so it can be reviewed for tone:
 *   1. Master "WrittenReports" tab (all weekly reports, every section)
 *   2. Each student's "📊 Scores" tab (curved-display numbers + Insight + CoachNote)
 *
 * Writes a single JSON blob to the path given as the first arg (default
 * /tmp/portal-tone-audit.json). NO writes to any sheet. Mirrors the env-loading
 * and quotaUser partitioning of scoreStudents.cjs.
 *
 *   node scripts/nas/dumpReportsAndScores.cjs [outfile.json]
 */
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const OUT = process.argv[2] || '/tmp/portal-tone-audit.json';
const MASTER_TAB = '👩‍🎓 All Data';
const REPORTS_TAB = 'WrittenReports';
const SCORES_TAB = '📊 Scores';

function envGet(key) {
  const candidates = [
    path.join(__dirname, '..', '..', '.env.local'),
    path.join(__dirname, '.env.local'),
  ];
  const file = candidates.find((p) => fs.existsSync(p));
  if (!file) throw new Error('.env.local not found beside script or at repo root');
  const env = fs.readFileSync(file, 'utf8');
  const m = env.match(new RegExp('^' + key + '=(.*)$', 'm'));
  return m ? m[1].replace(/^['"]|['"]$/g, '') : null;
}

function getSheets(quotaUser) {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: envGet('GOOGLE_SERVICE_ACCOUNT_EMAIL'),
      private_key: envGet('GOOGLE_PRIVATE_KEY').replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  return google.sheets({
    version: 'v4',
    auth,
    ...(quotaUser ? { params: { quotaUser: String(quotaUser).slice(0, 40) } } : {}),
  });
}

const MASTER_SHEET_ID = envGet('MASTER_SHEET_ID');

async function listStudents(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: MASTER_SHEET_ID,
    range: `'${MASTER_TAB}'!A:BD`,
  });
  const out = [];
  for (const r of (res.data.values || []).slice(1)) {
    const name = (r[0] || '').trim();
    const cls = (r[1] || '').trim();
    const m = (r[6] || '').match(/\/d\/([a-zA-Z0-9-_]+)/);
    if (!name || !m) continue;
    out.push({ name, cls, sheetId: m[1] });
  }
  return out;
}

async function readMasterReports(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: MASTER_SHEET_ID,
    range: `${REPORTS_TAB}!A:H`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const rows = res.data.values || [];
  return rows.slice(1)
    .map((r) => ({
      date: r[0] || '',
      student: r[1] || '',
      onTarget: r[2] || '',
      needsAttention: r[3] || '',
      strategy: r[4] || '',
      parentRequests: r[5] || '',
      status: r[6],
      parentNotified: r[7],
    }))
    .filter((r) => r.student);
}

async function readScores(sheetId) {
  const sheets = getSheets(sheetId);
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `'${SCORES_TAB}'!A2:I400`,
    });
    return (res.data.values || [])
      .filter((r) => r[0])
      .map((r) => {
        const isV1 = r[6] === 'v1';
        return {
          date: r[0],
          academic: r[1],
          ec: r[2],
          leadership: isV1 ? null : r[3],
          overall: isV1 ? r[3] : r[4],
          insight: (isV1 ? r[4] : r[5]) || '',
          coachNote: (isV1 ? r[5] : r[6]) || '',
          rubricVer: isV1 ? 'v1' : (r[7] || ''),
          model: (isV1 ? r[7] : r[8]) || '',
        };
      });
  } catch {
    return null; // no Scores tab
  }
}

async function main() {
  const master = getSheets();
  const [students, reports] = await Promise.all([
    listStudents(master),
    readMasterReports(master),
  ]);

  console.log(`${students.length} students, ${reports.length} written-report rows`);

  const scoresByStudent = {};
  for (const s of students) {
    process.stdout.write(`  scores: ${s.name} … `);
    const rows = await readScores(s.sheetId);
    scoresByStudent[s.name] = { cls: s.cls, sheetId: s.sheetId, rows };
    console.log(rows == null ? 'no tab' : `${rows.length} row(s)`);
  }

  fs.writeFileSync(
    OUT,
    JSON.stringify(
      { generatedAt: new Date().toISOString(), students, reports, scoresByStudent },
      null,
      2
    )
  );
  console.log(`\nWrote ${OUT}`);
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
