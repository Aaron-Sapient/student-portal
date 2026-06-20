/**
 * backfillScoreParams.cjs — mirror the global rubric weights from the Master
 * `⚙️ Score Params` tab into Supabase `score_params` (Bucket B). Stores the
 * EFFECTIVE config the app reads: lib/scoreParams.js DEFAULT_PARAMS overlaid
 * with any sheet rows (numeric, known keys) — so the table is self-sufficient
 * for step B even if the (hidden) tab is empty / absent.
 *
 *   node scripts/backfillScoreParams.cjs          # DRY RUN
 *   node scripts/backfillScoreParams.cjs --write   # upsert
 *
 * Source VERIFIED against lib/scoreParams.js:8,58-78 (range A2:B100, col0=key,
 * col1=weight; tab missing → defaults). Idempotent upsert on param_key.
 */
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');

const MASTER_SHEET_ID = '1YJK05oU_12wX0qK-vTqJJfaS8eVI7JMzdGP0gVso1G4';
const SCORE_PARAMS_TAB = '⚙️ Score Params';

// Mirror of lib/scoreParams.js DEFAULT_PARAMS (verified 2026-06-20).
const DEFAULT_PARAMS = {
  'academic.mathPathway': 25, 'academic.apLoad': 25, 'academic.gradesVsRigor': 25,
  'academic.satAct': 15, 'academic.apExams': 10,
  'ec.recognition': 40, 'ec.awards': 25, 'ec.selectivePrograms': 15, 'ec.yearsEngagement': 20,
  'leadership.positions': 40, 'leadership.inHouse': 30, 'leadership.sustained': 30,
  'overall.academic': 50, 'overall.ec': 30, 'overall.leadership': 20,
};

function loadEnv() {
  const env = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
  return (k) => {
    const m = env.match(new RegExp('^' + k + '=(.*)$', 'm'));
    return m ? m[1].replace(/^['"]|['"]$/g, '') : null;
  };
}

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
  const sb = createClient(get('SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });

  const effective = { ...DEFAULT_PARAMS };
  let sheetRows = 0;
  const overrides = [];
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: MASTER_SHEET_ID,
      range: `'${SCORE_PARAMS_TAB}'!A2:B100`,
    });
    for (const [key, value] of res.data.values || []) {
      sheetRows++;
      const n = Number(value);
      if (key in effective && Number.isFinite(n)) {
        if (effective[key] !== n) overrides.push(`${key}: ${effective[key]} → ${n}`);
        effective[key] = n;
      }
    }
  } catch (e) {
    console.log(`(tab '${SCORE_PARAMS_TAB}' not readable → pure defaults: ${e.message})`);
  }

  const records = Object.entries(effective).map(([param_key, weight]) => ({
    param_key, weight, updated_at: new Date().toISOString(),
  }));

  console.log(`Resolved ${records.length} score_params (${sheetRows} sheet rows; ${overrides.length} override(s) vs defaults).`);
  overrides.forEach((o) => console.log(`  Δ ${o}`));
  records.forEach((r) => console.log(`  ${r.param_key.padEnd(28)} ${r.weight}`));

  if (!WRITE) { console.log('\nDRY RUN — re-run with --write.'); return; }
  const { error } = await sb.from('score_params').upsert(records, { onConflict: 'param_key' });
  if (error) { console.error('upsert failed:', error.message); process.exit(1); }
  console.log(`\n✓ Upserted ${records.length} score_params.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
