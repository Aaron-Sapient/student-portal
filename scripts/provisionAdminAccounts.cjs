/**
 * provisionAdminAccounts.cjs — create Clerk accounts (dev + prod) for the
 * admin/instructor emails in ADMIN_EMAILS-adjacent use, so Ryan can sign in
 * with any of his addresses without caring which account he's in.
 *
 * Sibling of provisionStudentAccounts.cjs / provisionParentAccounts.cjs, but
 * email-list-driven instead of sheet-driven, and it sets NO role metadata —
 * mirroring ryan@sapientacademy.com's existing prod account (public_metadata
 * {}), so any role-based routing treats these exactly like his current login.
 *
 * SAFE BY DEFAULT: dry-run unless --commit. Idempotent: existing users are
 * left untouched.
 *
 *   node scripts/provisionAdminAccounts.cjs --email a@b.com [--email c@d.com] --commit
 *
 * Flags: --commit  --dev-only  --prod-only  --email <addr> (repeatable)
 *        --password <pw> (one per --email, positional; generated if omitted)
 *
 * Keys: CLERK_SECRET_KEY (dev, sk_test) and CLERK_SECRET_KEY_PROD (sk_live),
 * both read from .env.local. Credentials CSV lands in scripts/out/ (gitignored)
 * — distribute, then delete.
 */
const fs = require('fs');
const path = require('path');

const CLERK_API = 'https://api.clerk.com/v1';

const ADJECTIVES = ['amber', 'bold', 'brave', 'bright', 'calm', 'cedar', 'clear', 'clever', 'coral', 'crisp', 'eager', 'ember', 'golden', 'grand', 'hazel', 'indigo', 'jade', 'keen', 'lively', 'lucky', 'maple', 'mighty', 'noble', 'opal', 'pearl', 'proud', 'quiet', 'regal', 'river', 'royal', 'sandy', 'serene', 'silver', 'smart', 'solar', 'stellar', 'sturdy', 'sunny', 'swift', 'teal', 'tidal', 'true', 'vivid', 'warm', 'wise', 'witty'];
const NOUNS = ['acorn', 'anchor', 'aspen', 'badger', 'beacon', 'birch', 'bison', 'breeze', 'brook', 'canyon', 'cliff', 'comet', 'compass', 'crane', 'creek', 'delta', 'dolphin', 'eagle', 'falcon', 'forest', 'garden', 'grove', 'harbor', 'hawk', 'heron', 'horizon', 'island', 'lagoon', 'lantern', 'lark', 'lily', 'lotus', 'meadow', 'mesa', 'mountain', 'oasis', 'ocean', 'orchard', 'osprey', 'otter', 'owl', 'pebble', 'pine', 'prairie', 'raven', 'reef', 'ridge', 'robin', 'sage', 'sparrow', 'summit', 'sunrise', 'tiger', 'trail', 'tulip', 'valley', 'vista', 'walnut', 'wave', 'willow', 'wren', 'zephyr'];

function generatePassword() {
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}-${String(Math.floor(Math.random() * 90) + 10)}`;
}

function loadEnv() {
  const env = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
  return (k) => {
    const m = env.match(new RegExp('^' + k + '=(.*)$', 'm'));
    return m ? m[1].replace(/^['"]|['"]$/g, '') : null;
  };
}

async function clerk(key, method, pathname, body) {
  const res = await fetch(`${CLERK_API}${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, json };
}

async function findUser(key, email) {
  const { status, json } = await clerk(key, 'GET', `/users?email_address=${encodeURIComponent(email)}&limit=1`);
  if (status !== 200) throw new Error(`Clerk GET /users → ${status}: ${JSON.stringify(json)}`);
  return Array.isArray(json) && json.length ? json[0] : null;
}

const pwnedOrInvalid = (json) =>
  JSON.stringify(json || '').match(/form_password_pwned|form_password_length|password/i);

async function main() {
  const get = loadEnv();
  const args = process.argv.slice(2);
  const COMMIT = args.includes('--commit');
  const DEV_ONLY = args.includes('--dev-only');
  const PROD_ONLY = args.includes('--prod-only');
  const emails = [];
  const passwords = [];
  args.forEach((a, i) => {
    if (a === '--email') emails.push(String(args[i + 1] || '').trim().toLowerCase());
    if (a === '--password') passwords.push(String(args[i + 1] || ''));
  });
  if (!emails.length || emails.some((e) => !/@/.test(e))) {
    throw new Error('Pass at least one valid --email <addr>');
  }
  const log = (...a) => console.log(COMMIT ? '[commit]' : '[dry-run]', ...a);

  const instances = [];
  if (!PROD_ONLY) {
    const key = get('CLERK_SECRET_KEY');
    if (!key || !key.startsWith('sk_test_')) throw new Error('CLERK_SECRET_KEY (sk_test) missing from .env.local');
    instances.push({ name: 'dev', key });
  }
  if (!DEV_ONLY) {
    const key = get('CLERK_SECRET_KEY_PROD');
    if (!key || !key.startsWith('sk_live_')) throw new Error('CLERK_SECRET_KEY_PROD (sk_live) missing from .env.local');
    instances.push({ name: 'prod', key });
  }

  const results = [];
  for (const [idx, email] of emails.entries()) {
    let password = passwords[idx] || generatePassword();
    const row = { email, password };
    for (const inst of instances) {
      await new Promise((r) => setTimeout(r, 120));
      try {
        const existing = await findUser(inst.key, email);
        if (existing) { row[inst.name] = `exists (${existing.id})`; continue; }
        if (!COMMIT) { row[inst.name] = 'would create'; continue; }
        let created = await clerk(inst.key, 'POST', '/users', { email_address: [email], password });
        if (created.status === 422 && pwnedOrInvalid(created.json)) {
          password = generatePassword();
          row.password = password;
          created = await clerk(inst.key, 'POST', '/users', { email_address: [email], password });
        }
        row[inst.name] = created.status === 200
          ? `created (${created.json.id})`
          : `error ${created.status}: ${JSON.stringify(created.json?.errors?.[0]?.message || created.json)}`;
      } catch (err) {
        row[inst.name] = `error: ${err.message}`;
      }
    }
    results.push(row);
    log(`${email.padEnd(32)} ${instances.map((i) => `${i.name}=${row[i.name]}`).join('  ')}`);
  }

  if (COMMIT && results.length) {
    const outDir = path.join(__dirname, 'out');
    fs.mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const csvPath = path.join(outDir, `admin-credentials-${stamp}.csv`);
    const cols = ['email', 'password', ...instances.map((i) => i.name)];
    const csv = [cols.join(','), ...results.map((r) => cols.map((c) => `"${String(r[c] ?? '').replace(/"/g, '""')}"`).join(','))].join('\n');
    fs.writeFileSync(csvPath, csv);
    log(`credentials CSV → ${csvPath}  (delete after distributing!)`);
  }

  console.log(COMMIT ? '\n✅ committed.\n' : '\nℹ️  dry-run only — re-run with --commit to apply.\n');
}

main().catch((err) => { console.error('❌', err.message); process.exit(1); });
