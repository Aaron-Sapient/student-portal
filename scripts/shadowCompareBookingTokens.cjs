/**
 * shadowCompareBookingTokens.cjs — offline parity check for the BOOKING-TOKENS
 * read cutover (domain `booking_tokens`, the real-time booking-auth gate). Run:
 *
 *   node scripts/shadowCompareBookingTokens.cjs
 *
 * WHY offline (not just READ_SUPABASE_BOOKING_TOKENS=shadow): the only reader is
 * validateBooking, which fires ONLY when a student actually attempts a booking —
 * so organic shadow traffic is far too sparse to trust before flipping the auth
 * gate. This harness diffs EVERY (student, instructor) cell at once.
 *
 * It models the READER (app/api/validateBooking/route.js), NOT the backfill:
 *   • Master `👩‍🎓 All Data` is read with valueRenderOption UNFORMATTED_VALUE and
 *     range A:BD — byte-identical to validateBooking's own studentRow read. (The
 *     backfill uses the DEFAULT FORMATTED_VALUE; that difference is exactly the
 *     kind of divergence this check exists to catch — see the ART note below.)
 *   • For each instructor the reader's Sheets value is `studentRow[col] || ''`
 *     (AZ=51 ryan, BB=53 aaron, BD=55 art), keyed to the mirror by the col-G
 *     (index 6) portal-doc id — the same id validateBooking derives.
 *   • The mirror value is booking_tokens.token_value for (student_sheet_id,
 *     instructor), or '' when no row (getBookingTokenFromSupabase → maybeSingle →
 *     `token_value ?? ''`). We replicate lib/bookingTokens.js diffBookingToken:
 *     String(sheetVal) === String(supaVal), NO trimming (the reader doesn't trim).
 *
 * EXPECTED, ACCEPTABLE (sign off, don't block):
 *   - SENIORS are EXCLUDED from the comparison — validateBooking's senior guard
 *     (getSeniorByEmail → early return) means a senior NEVER reaches getBookingToken,
 *     and the mirror deliberately omits them (they use the senior_* ledger). They
 *     often carry stale legacy AZ/BB/BD cells; those are read-irrelevant, so counting
 *     them would be a false "sheets-only" storm. A senior WITH a mirror row is a LEAK
 *     worth noting (self-heals via the --reconcile prune; read-inert while flag off).
 * MUST-INVESTIGATE-BEFORE-FLIP (any of these is a BLOCKER):
 *   - ART (col BD) numeric-vs-string: the cell returns a NUMBER under
 *     UNFORMATTED_VALUE (a date serial) while the mirror stores the verbatim ISO.
 *     Flipping to `on` would then change what the ART Saturday-reset comparison
 *     sees. This is the #1 predicted risk; the harness flags it explicitly.
 *   - any value-differs on a ryan/aaron token (15min/30min/no/pending/written/
 *     email) — those are plain text, so a mismatch means a stale/missing mirror.
 *   - sheets-only (live token, no mirror row) — a dual-write or reconcile miss;
 *     under `on` the reader would see '' and wrongly treat the student as
 *     ungated/bookable. The most dangerous class for a gate.
 *
 * Read-only against both Sheets and Supabase. Exit 1 if any blocker diff exists.
 */
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');

const MASTER_SHEET_ID = '1YJK05oU_12wX0qK-vTqJJfaS8eVI7JMzdGP0gVso1G4';
const MASTER_TAB = "'👩‍🎓 All Data'";
const COL_G = 6; // portal-doc URL
const COL_J = 9; // student email (row-lookup key in validateBooking)
// slug ← Master column index (0-based). Matches validateBooking COLUMN_INDEX.
const TOKEN_COLS = [['ryan', 51], ['aaron', 53], ['art', 55]];

function loadEnv() {
  const env = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
  return (k) => {
    const m = env.match(new RegExp('^' + k + '=(.*)$', 'm'));
    return m ? m[1].replace(/^['"]|['"]$/g, '') : null;
  };
}
const sheetId = (url) => {
  const m = String(url ?? '').match(/\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : null;
};

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
  const sb = createClient(get('SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false },
  });

  // seniors (table membership) — the mirror deliberately excludes them.
  const { data: seniorRows, error: sErr } = await sb.from('seniors').select('student_sheet_id');
  if (sErr) throw sErr;
  const seniors = new Set((seniorRows || []).map((r) => r.student_sheet_id));

  // ── Sheets side: EXACTLY validateBooking's read (UNFORMATTED_VALUE, A:BD) ──
  const rows = (await sheets.spreadsheets.values.get({
    spreadsheetId: MASTER_SHEET_ID,
    range: `${MASTER_TAB}!A:BD`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  })).data.values || [];

  // `${id}|${slug}` → { raw, arg }   (arg = studentRow[col] || '', the reader's sheetVal)
  const sheetTok = new Map();
  const idEmail = new Map(); // id → email (for reporting)
  const idIsSenior = new Map();
  for (const r of rows) {
    const id = sheetId(r?.[COL_G]);
    if (!id) continue;
    idEmail.set(id, String(r?.[COL_J] ?? ''));
    const isSenior = seniors.has(id);
    idIsSenior.set(id, isSenior);
    // Seniors never reach getBookingToken (validateBooking returns at the senior
    // guard before the token read) and the mirror omits them by design — so their
    // legacy AZ/BB/BD cells are read-irrelevant. Excluding them here models the
    // reader faithfully; a senior with a mirror row still trips the leak check below.
    if (isSenior) continue;
    for (const [slug, col] of TOKEN_COLS) {
      const raw = r?.[col];
      const arg = raw || ''; // model `studentRow[col] || ''` verbatim (number stays number)
      sheetTok.set(`${id}|${slug}`, { raw, arg });
    }
  }

  // ── Supabase side: the whole booking_tokens mirror ──
  const { data: mirror, error: mErr } = await sb
    .from('booking_tokens')
    .select('student_sheet_id, instructor, token_value');
  if (mErr) throw mErr;
  const supaTok = new Map(); // `${id}|${instructor}` → token_value
  for (const row of mirror || []) {
    supaTok.set(`${row.student_sheet_id}|${row.instructor}`, row.token_value);
  }

  // ── Compare every (student, instructor) exactly like diffBookingToken ──
  let bothEmpty = 0;
  let match = 0;
  const mismatches = []; // { id, email, slug, kind, sheetsSays, supaSays, artNumeric }
  const seniorLeaks = []; // { id, email, slug, token_value }

  const keys = new Set([...sheetTok.keys(), ...supaTok.keys()]);
  for (const key of keys) {
    const [id, slug] = key.split('|');
    const s = sheetTok.get(key); // may be undefined if the id exists only in the mirror
    const sheetArg = s ? s.arg : ''; // no Master row for this id ⇒ reader sees ''
    const A = String(sheetArg ?? ''); // reader's Sheets value (off/shadow/fallback)
    const hasSupaRow = supaTok.has(key);
    const B = String(hasSupaRow ? (supaTok.get(key) ?? '') : ''); // reader's `on` value

    // senior leak: mirror row for a senior (should never exist)
    if (hasSupaRow && idIsSenior.get(id)) {
      seniorLeaks.push({ id, email: idEmail.get(id) || '(unknown)', slug, token_value: B });
    }

    if (A === '' && B === '') { bothEmpty++; continue; }
    if (A === B) { match++; continue; }

    // classify the mismatch
    const artNumeric = slug === 'art' && s && typeof s.raw === 'number';
    let kind;
    if (A !== '' && B === '') kind = 'sheets-only (mirror MISSING a live token — under `on` the gate would see the student as ungated)';
    else if (A === '' && B !== '') kind = 'supa-only (stale mirror row — Master cell is blank)';
    else kind = 'value-differs';
    mismatches.push({
      id, email: idEmail.get(id) || '(unknown)', slug, kind,
      sheetsSays: JSON.stringify(sheetArg), supaSays: JSON.stringify(B), artNumeric,
    });
  }

  // ── Report ──
  console.log('\n── BOOKING-TOKENS shadow parity (models validateBooking, UNFORMATTED_VALUE) ──');
  console.log(`master rows w/ portal id: ${idEmail.size}   mirror rows: ${(mirror || []).length}   seniors excluded: ${seniors.size}`);
  console.log(`cells compared: ${keys.size}`);
  console.log(`  ✓ match (non-empty, equal): ${match}`);
  console.log(`  · both empty (no token either side): ${bothEmpty}`);
  console.log(`  ✗ mismatch: ${mismatches.length}`);

  if (seniorLeaks.length) {
    console.log(`\n⚠ senior mirror leaks (read-inert while flag off; --reconcile prunes): ${seniorLeaks.length}`);
    for (const l of seniorLeaks) console.log(`    ${l.email} (${l.id.slice(0, 12)}…) ${l.slug}=${JSON.stringify(l.token_value)}`);
  }

  if (mismatches.length) {
    const art = mismatches.filter((m) => m.artNumeric);
    console.log('\n  Mismatch detail:');
    for (const m of mismatches) {
      const flag = m.artNumeric ? '  ⟵ ART cell is a NUMBER (serial) under UNFORMATTED_VALUE vs ISO in mirror — BLOCKER' : '';
      console.log(`    ✗ ${m.email} (${m.id.slice(0, 12)}…) [${m.slug}] ${m.kind}`);
      console.log(`        sheets=${m.sheetsSays}  supa=${m.supaSays}${flag}`);
    }
    if (art.length) {
      console.log(`\n  ✗ ${art.length} ART numeric-vs-ISO mismatch(es): flipping to \`on\` WOULD change what the Saturday-reset sees. Resolve before any flip.`);
    }
    console.log('\nNot flip-ready: investigate every mismatch above. sheets-only on a gate is the most dangerous class.');
    process.exitCode = 1;
  } else {
    console.log('\n✓ Full parity — every booking-token cell matches between Sheets (as the reader reads it) and the mirror. Flip-ready pending adversarial + temporal-edge review.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
