/**
 * seedLeadPages.mjs — push the local per-lead JSON files into Supabase
 * `lead_pages`, which is where /next/<slug> actually reads them from.
 *
 *   node scripts/seedLeadPages.mjs                 # dry run: says what it WOULD write
 *   node scripts/seedLeadPages.mjs --commit        # upsert every file
 *   node scripts/seedLeadPages.mjs --commit conor-c44061   # just this slug
 *   node scripts/seedLeadPages.mjs --list          # what is in the table now
 *
 * Dry run by default, on purpose: these rows are what a family sees, and the
 * upsert REPLACES `data` wholesale, EXCEPT `data.booked`, which is state
 * rather than copy and is carried across from the row's own columns.
 *
 * Why this script exists at all. app/next/leads/*.json is gitignored, because a
 * lead file carries a minor's first name, a parent's email address and phone
 * number, and this repository is public. That leaves the files unable to reach a
 * Vercel build, which builds from git. The table is the home; the files are the
 * editing surface and this is the one-way door between them. Editing a file
 * changes nothing until this runs.
 *
 * Direction is one-way by design (disk → table, never table → disk): the table
 * is the source of truth for what is live, and a two-way sync would make "which
 * version did the family see" unanswerable.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEADS_DIR = path.join(__dirname, '..', 'app', 'next', 'leads');
const TABLE = 'lead_pages';

function loadEnv() {
  const env = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
  return (k) => {
    const m = env.match(new RegExp('^' + k + '=(.*)$', 'm'));
    return m ? m[1].replace(/^['"]|['"]$/g, '') : null;
  };
}

const args = process.argv.slice(2);
const commit = args.includes('--commit');
const list = args.includes('--list');
const only = args.filter((a) => !a.startsWith('--'));

const get = loadEnv();
const url = get('SUPABASE_URL');
const key = get('SUPABASE_SERVICE_ROLE_KEY');
if (!url || !key) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

if (list) {
  const { data, error } = await sb
    .from(TABLE)
    .select('slug, updated_at')
    .order('updated_at', { ascending: false });
  if (error) {
    console.error('read failed:', error.message);
    process.exit(1);
  }
  console.log(`${data.length} row(s) in ${TABLE}:`);
  for (const r of data) console.log(`  ${r.slug}  (updated ${r.updated_at})`);
  process.exit(0);
}

let files = fs
  .readdirSync(LEADS_DIR)
  .filter((f) => f.endsWith('.json'))
  /* The committed example is a template, not a family. It never goes to the
     table; seeding it would publish a page at /next/example-a1b2c3 whose only
     purpose is to be copied. */
  .filter((f) => !f.startsWith('example-'));

if (only.length) files = files.filter((f) => only.includes(f.replace(/\.json$/, '')));

if (!files.length) {
  console.error('No lead files matched. Looked in', LEADS_DIR);
  process.exit(1);
}

let failed = 0;
for (const f of files) {
  const slug = f.replace(/\.json$/, '');
  let data;
  try {
    data = JSON.parse(fs.readFileSync(path.join(LEADS_DIR, f), 'utf8'));
  } catch (e) {
    console.error(`  SKIP ${slug}: not valid JSON (${e.message})`);
    failed++;
    continue;
  }

  /* Two cheap checks before anything is written, because both failures are
     silent on the page rather than loud: a slug that is not <lead>-<6 hex> is
     guessable, and the page addresses the family by `student` and tags the
     booking with `id`. */
  /* The slug is the student's FIRST NAME, lowercase ASCII (conor), or
     first-last when two live leads share one (conor-min). The old <lead>-<6 hex>
     requirement is gone by Aaron's call on 2026-09-03: a guessable address is
     the deliberate cost of a page that reads as high-touch. */
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    console.error(`  SKIP ${slug}: slug must be lowercase ASCII, one name or first-last.`);
    failed++;
    continue;
  }
  for (const field of ['id', 'student', 'booking']) {
    if (!data[field]) {
      console.error(`  SKIP ${slug}: missing required field "${field}"`);
      failed++;
      continue;
    }
  }

  if (!commit) {
    console.log(`  would upsert ${slug}  (${data.student}, ${JSON.stringify(data).length} bytes)`);
    continue;
  }

  /* A BOOKING SURVIVES A RE-SEED (2026-09-05, after this bit me).
     This upsert replaces `data` wholesale, and `data.booked` lives inside it,
     so re-seeding a row to fix one line of copy silently erased a confirmed
     booking: the columns and the Google event both survived, the page went back
     to offering times, and nothing errored. The old defence was a sentence in a
     handoff telling a human to remember, which is the kind of defence that
     works right up until someone is three edits deep at midnight.

     `data` is copy and is meant to be replaced. `data.booked` is STATE and is
     carried across from whatever is already in the row. The columns are the
     authority (recordLeadBooking writes both), so they are what gets rebuilt
     from, not the jsonb that is about to be overwritten. */
  const { data: existing } = await sb
    .from(TABLE)
    .select('booked_event_id, booked_start, booked_at')
    .eq('slug', slug)
    .maybeSingle();

  const preserved = existing?.booked_event_id
    ? {
        ...data,
        booked: {
          event_id: existing.booked_event_id,
          start: existing.booked_start,
          booked_at: existing.booked_at,
        },
      }
    : data;
  if (existing?.booked_event_id) {
    console.log(`  (${slug} holds a booking; carrying it across the re-seed)`);
  }

  const { error } = await sb
    .from(TABLE)
    .upsert({ slug, data: preserved, updated_at: new Date().toISOString() }, { onConflict: 'slug' });
  if (error) {
    console.error(`  FAIL ${slug}: ${error.message}`);
    failed++;
  } else {
    console.log(`  upserted ${slug}  (${data.student})`);
  }
}

if (!commit) console.log('\nDry run. Nothing was written. Re-run with --commit.');
process.exit(failed ? 1 : 0);
