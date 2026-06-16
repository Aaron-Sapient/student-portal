/**
 * testQuotaUser.cjs — empirically check whether the Sheets API respects the
 * `quotaUser` param for service-account (OAuth) requests, i.e. whether the
 * 60 reads/min/user quota is metered per quotaUser string or per credential.
 *
 * Method: ~90 tiny reads of Master!A1 as fast as possible, alternating
 * quotaUser 'qu-test-a' / 'qu-test-b' (45 each).
 *   - quotaUser respected  → each bucket sees 45/min → expect ZERO 429s.
 *   - quotaUser ignored    → one shared bucket → expect 429s near request ~61.
 *
 * NOTE: if ignored, this test itself burns the shared per-user read quota for
 * up to a minute — run it when nobody's actively using the dev portal.
 */
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

function loadEnv() {
  const env = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
  return (k) => {
    const m = env.match(new RegExp('^' + k + '=(.*)$', 'm'));
    return m ? m[1].replace(/^['"]|['"]$/g, '') : null;
  };
}

async function main() {
  const get = loadEnv();
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: get('GOOGLE_SERVICE_ACCOUNT_EMAIL'),
      private_key: get('GOOGLE_PRIVATE_KEY').replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const spreadsheetId = get('MASTER_SHEET_ID');

  const TOTAL = 90;
  const CONCURRENCY = 6; // fast enough to land inside one quota window
  let sent = 0;
  let ok = 0;
  let firstErrAt = null;
  const errors = [];

  async function worker(id) {
    while (true) {
      const n = ++sent;
      if (n > TOTAL) return;
      const quotaUser = n % 2 === 0 ? 'qu-test-a' : 'qu-test-b';
      try {
        await sheets.spreadsheets.values.get({
          spreadsheetId,
          range: "'👩‍🎓 All Data'!A1",
          quotaUser,
        });
        ok++;
      } catch (err) {
        const code = err?.code || err?.response?.status;
        if (firstErrAt === null) firstErrAt = n;
        errors.push({ n, quotaUser, code, msg: String(err.message).slice(0, 80) });
      }
      if (n % 15 === 0) console.log(`  ...${n}/${TOTAL} sent, ${ok} ok, ${errors.length} errors`);
    }
  }

  const t0 = Date.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i)));
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`\n${TOTAL} requests in ${secs}s — ${ok} ok, ${errors.length} errors`);
  if (errors.length) {
    console.log(`first error at request #${firstErrAt}:`);
    for (const e of errors.slice(0, 3)) console.log(`  #${e.n} [${e.quotaUser}] ${e.code}: ${e.msg}`);
    const codes = new Set(errors.map((e) => e.code));
    if (codes.has(429)) {
      console.log(
        firstErrAt > 55
          ? '\n❌ VERDICT: quotaUser IGNORED — 429s began near the shared 60/min mark.'
          : '\n❌ VERDICT: 429s began early — shared bucket already partly consumed; quotaUser still looks ignored.'
      );
    }
  } else {
    console.log('\n✅ VERDICT: quotaUser RESPECTED — 90 reads (45/bucket) cleared with zero 429s.');
    console.log('   (Shared-bucket behavior would have 429ed around #61.)');
  }
}

main().catch((e) => {
  console.error('❌ setup error:', e.message);
  process.exit(1);
});
