/**
 * provisionStudentAccounts.cjs — create student Clerk accounts (dev + prod)
 * from Master Sheet student emails (👩‍🎓 All Data col J), generate passwords,
 * and write them back to col AW ("Portal Pass.").
 *
 * SAFE BY DEFAULT: dry-run unless --commit (no Clerk writes, no sheet writes).
 * Idempotent: existing Clerk users are skipped (their publicMetadata.role is
 * patched to 'student' if missing); a filled AW cell is never overwritten —
 * an existing stored password is reused so reruns converge.
 *
 * NC rows (col B === "NC") are skipped — those students get no portal
 * identity at all (see lib/identity.js isNC), so no Clerk account either.
 *
 *   node scripts/provisionStudentAccounts.cjs                                    # dry-run, all students, dev+prod
 *   node scripts/provisionStudentAccounts.cjs --email a@b.com --prod-only --commit
 *   node scripts/provisionStudentAccounts.cjs --commit                           # full run, dev + prod
 *
 * Flags: --commit  --dev-only  --prod-only  --email <addr>  --limit <N>
 *        --reset-password  (PATCH the generated password onto Clerk users that
 *                           already exist but have no password stored in the sheet)
 *
 * Keys: CLERK_SECRET_KEY (dev, sk_test) and CLERK_SECRET_KEY_PROD (sk_live),
 * both read from .env.local. Output CSV lands in scripts/out/ (gitignored) —
 * distribute the credential, then delete it.
 */
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const MASTER_TAB = '👩‍🎓 All Data';
const CLERK_API = 'https://api.clerk.com/v1';

// Same memorable scheme as provisionParentAccounts.cjs: adjective-noun-NN.
const ADJECTIVES = [
  'amber', 'autumn', 'azure', 'bold', 'brave', 'breezy', 'bright', 'calm', 'cedar', 'clear',
  'clever', 'coral', 'cosmic', 'crisp', 'daring', 'dawn', 'eager', 'early', 'ember', 'fable',
  'fair', 'fern', 'frosty', 'gentle', 'gilded', 'glad', 'golden', 'grand', 'green', 'happy',
  'hazel', 'honest', 'indigo', 'ivory', 'jade', 'jolly', 'keen', 'kind', 'lively', 'lucky',
  'lunar', 'maple', 'mellow', 'mighty', 'misty', 'noble', 'north', 'oaken', 'olive', 'opal',
  'pearl', 'plucky', 'proud', 'quiet', 'rapid', 'regal', 'river', 'rosy', 'royal', 'rustic',
  'sandy', 'scarlet', 'serene', 'silver', 'smart', 'snowy', 'solar', 'spry', 'stellar', 'stormy',
  'sturdy', 'sunny', 'swift', 'teal', 'tidal', 'topaz', 'tranquil', 'true', 'velvet', 'vivid',
  'warm', 'wild', 'windy', 'wise', 'witty', 'zesty',
];
const NOUNS = [
  'acorn', 'anchor', 'aspen', 'badger', 'beacon', 'birch', 'bison', 'breeze', 'brook', 'canyon',
  'cedar', 'cliff', 'cloud', 'comet', 'compass', 'coral', 'crane', 'creek', 'delta', 'dolphin',
  'eagle', 'ember', 'falcon', 'fjord', 'forest', 'garden', 'glacier', 'grove', 'harbor', 'hawk',
  'heron', 'hill', 'horizon', 'island', 'lagoon', 'lantern', 'lark', 'lighthouse', 'lily', 'lotus',
  'meadow', 'mesa', 'mountain', 'nebula', 'oasis', 'ocean', 'orchard', 'osprey', 'otter', 'owl',
  'panda', 'pebble', 'pine', 'prairie', 'puffin', 'quail', 'raven', 'reef', 'ridge', 'river',
  'robin', 'sage', 'sequoia', 'sparrow', 'spring', 'summit', 'sunrise', 'thicket', 'tiger', 'trail',
  'tulip', 'valley', 'vista', 'walnut', 'wave', 'willow', 'wren', 'zephyr',
];

function generatePassword() {
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const nn = String(Math.floor(Math.random() * 90) + 10);
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}-${nn}`;
}

const normEmail = (v) => String(v ?? '').trim().toLowerCase();
const isEmail = (v) => /@/.test(v);
const isNC = (v) => String(v ?? '').trim().toUpperCase() === 'NC';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadEnv() {
  const env = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
  return (k) => {
    const m = env.match(new RegExp('^' + k + '=(.*)$', 'm'));
    return m ? m[1].replace(/^['"]|['"]$/g, '') : null;
  };
}

// ── Clerk Backend API (raw fetch — no extra deps) ────────────────────────────

async function clerk(key, method, pathname, body) {
  const res = await fetch(`${CLERK_API}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  return { status: res.status, json };
}

async function findUser(key, email) {
  const { status, json } = await clerk(
    key,
    'GET',
    `/users?email_address=${encodeURIComponent(email)}&limit=1`
  );
  if (status !== 200) throw new Error(`Clerk GET /users → ${status}: ${JSON.stringify(json)}`);
  return Array.isArray(json) && json.length ? json[0] : null;
}

async function createUser(key, email, password) {
  return clerk(key, 'POST', '/users', {
    email_address: [email],
    password,
    public_metadata: { role: 'student' },
  });
}

const pwnedOrInvalid = (json) =>
  JSON.stringify(json || '').match(/form_password_pwned|form_password_length|password/i);

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const get = loadEnv();
  const args = process.argv.slice(2);
  const COMMIT = args.includes('--commit');
  const DEV_ONLY = args.includes('--dev-only');
  const PROD_ONLY = args.includes('--prod-only');
  const RESET_PW = args.includes('--reset-password');
  const onlyEmail = args.includes('--email')
    ? normEmail(args[args.indexOf('--email') + 1])
    : null;
  const limit = args.includes('--limit')
    ? parseInt(args[args.indexOf('--limit') + 1], 10)
    : Infinity;
  const log = (...a) => console.log(COMMIT ? '[commit]' : '[dry-run]', ...a);

  const MASTER_SHEET_ID = get('MASTER_SHEET_ID');
  const instances = [];
  if (!PROD_ONLY) {
    const key = get('CLERK_SECRET_KEY');
    if (!key || !key.startsWith('sk_test_'))
      throw new Error('CLERK_SECRET_KEY (sk_test) missing from .env.local');
    instances.push({ name: 'dev', key });
  }
  if (!DEV_ONLY) {
    const key = get('CLERK_SECRET_KEY_PROD');
    if (!key || !key.startsWith('sk_live_'))
      throw new Error(
        'CLERK_SECRET_KEY_PROD (sk_live) missing from .env.local — add it or pass --dev-only'
      );
    instances.push({ name: 'prod', key });
  }

  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: get('GOOGLE_SERVICE_ACCOUNT_EMAIL'),
      private_key: get('GOOGLE_PRIVATE_KEY').replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  // ── Read the roster ────────────────────────────────────────────────────────
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: MASTER_SHEET_ID,
    range: `'${MASTER_TAB}'!A:AW`,
  });
  const rows = res.data.values || [];

  // Col indices: A=0 name, B=1 class, J=9 student email, AW=48 portal password.
  const targets = [];
  rows.forEach((r, i) => {
    if (i === 0) return; // header
    const name = String(r[0] ?? '').trim();
    const email = normEmail(r[9]);
    if (!name || !isEmail(email)) return;
    if (isNC(r[1])) return; // NC = no portal identity at all
    if (onlyEmail && email !== onlyEmail) return;
    targets.push({
      row1: i + 1,
      name,
      klass: String(r[1] ?? '').trim(),
      email,
      existing: String(r[48] ?? '').trim(),
    });
  });

  const limited = targets.slice(0, limit);
  log(
    `${targets.length} student(s) matched` +
      (onlyEmail ? ` (filtered to ${onlyEmail})` : '') +
      `, processing ${limited.length}` +
      ` against [${instances.map((i) => i.name).join(', ')}]`
  );

  // ── Resolve passwords (reuse stored, else generate) ────────────────────────
  for (const t of limited) {
    t.password = t.existing || generatePassword();
  }

  // ── Clerk provisioning ─────────────────────────────────────────────────────
  const results = []; // { name, email, password, dev, prod }
  for (const t of limited) {
    const row = { name: t.name, email: t.email, password: t.password };
    for (const inst of instances) {
      await sleep(120); // stay well under Clerk's rate limits
      try {
        const existing = await findUser(inst.key, t.email);
        if (existing) {
          let status = 'exists';
          if (existing.public_metadata?.role !== 'student') {
            if (COMMIT) {
              const patch = await clerk(inst.key, 'PATCH', `/users/${existing.id}/metadata`, {
                public_metadata: { ...existing.public_metadata, role: 'student' },
              });
              status = patch.status === 200 ? 'exists+role-set' : `exists (role patch ${patch.status})`;
            } else status = 'exists (would set role)';
          }
          if (!t.existing) {
            if (RESET_PW && COMMIT) {
              const patch = await clerk(inst.key, 'PATCH', `/users/${existing.id}`, {
                password: t.password,
              });
              status += patch.status === 200 ? '+pw-reset' : `+pw-reset-failed(${patch.status})`;
            } else {
              status += ' (unknown password — sheet empty; --reset-password to set)';
            }
          }
          row[inst.name] = status;
          continue;
        }
        if (!COMMIT) {
          row[inst.name] = 'would create';
          continue;
        }
        let created = await createUser(inst.key, t.email, t.password);
        if (created.status === 422 && pwnedOrInvalid(created.json)) {
          t.password = generatePassword();
          row.password = t.password;
          created = await createUser(inst.key, t.email, t.password);
        }
        row[inst.name] =
          created.status === 200
            ? 'created'
            : `error ${created.status}: ${JSON.stringify(created.json?.errors?.[0]?.message || created.json)}`;
      } catch (err) {
        row[inst.name] = `error: ${err.message}`;
      }
    }
    results.push(row);
    log(
      `${t.name.padEnd(24)} ${t.email.padEnd(32)} ${instances
        .map((i) => `${i.name}=${row[i.name]}`)
        .join('  ')}`
    );
  }

  // ── Sheet write-back (empty cell only) ─────────────────────────────────────
  const writes = [];
  const header = rows[0] || [];
  if (!String(header[48] ?? '').trim())
    writes.push({ range: `'${MASTER_TAB}'!AW1`, values: [['Portal Pass.']] });
  for (const t of limited) {
    if (t.existing) continue; // never clobber
    writes.push({ range: `'${MASTER_TAB}'!AW${t.row1}`, values: [[t.password]] });
  }
  if (writes.length && COMMIT) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: MASTER_SHEET_ID,
      requestBody: { valueInputOption: 'RAW', data: writes },
    });
  }
  log(`${writes.length} sheet cell(s) ${COMMIT ? 'written' : 'would be written'} (AW).`);

  // ── Credentials CSV ────────────────────────────────────────────────────────
  if (results.length) {
    const outDir = path.join(__dirname, 'out');
    fs.mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const csvPath = path.join(outDir, `student-credentials-${stamp}.csv`);
    const cols = ['name', 'email', 'password', ...instances.map((i) => i.name)];
    const csv = [
      cols.join(','),
      ...results.map((r) =>
        cols.map((c) => `"${String(r[c] ?? '').replace(/"/g, '""')}"`).join(',')
      ),
    ].join('\n');
    fs.writeFileSync(csvPath, csv);
    log(`credentials CSV → ${csvPath}  (delete after distributing!)`);
  }

  console.log(
    COMMIT ? '\n✅ committed.\n' : '\nℹ️  dry-run only — re-run with --commit to apply.\n'
  );
}

main().catch((err) => {
  console.error('❌', err.message);
  process.exit(1);
});
