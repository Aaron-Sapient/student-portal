/**
 * backfillUcPiqTab.mjs — one-time backfill so every active Class-of-2027 senior's
 * UC PIQ document has a single combined "UC PIQs" tab (the literal parallel to the
 * Common App "Personal Statement"). Going forward, ensureDocuments() seeds this tab
 * at doc birth; this script covers the seniors whose UC_PIQ doc already existed
 * (empty) before that behavior landed.
 *
 * Idempotent: skips any senior whose UC PIQ doc already has a "UC PIQs" tab. The
 * college-list-driven synced PIQ tabs (created when a student checks prompts in
 * their sheet) are left untouched and coexist with the combined tab.
 *
 *   node scripts/backfillUcPiqTab.mjs            # dry run (report, no writes)
 *   node scripts/backfillUcPiqTab.mjs --write    # seed the "UC PIQs" tabs
 */
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import {
  ensureDocuments,
  listTabsOrdered,
  seedDefaultTab,
} from '../lib/writingDocs.js';

const WRITE = process.argv.includes('--write');
const TAB_TITLE = 'UC PIQs';

const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
    })
);
const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const { data: seniors, error } = await sb
  .from('seniors')
  .select('student_sheet_id, student_email, student_name')
  .eq('active', true);
if (error) {
  console.error('Failed to read seniors:', error.message);
  process.exit(1);
}

console.log(`${seniors.length} active senior(s)${WRITE ? '' : ' (DRY RUN — pass --write to seed)'}\n`);

let created = 0;
let already = 0;
for (const s of seniors) {
  const student = { email: s.student_email, name: s.student_name };
  const docs = await ensureDocuments(sb, s.student_sheet_id, student);
  const ucDoc = docs.UC_PIQ;
  if (!ucDoc) {
    console.log(`  ! ${s.student_name.padEnd(24)} no UC_PIQ doc (unexpected) — skipped`);
    continue;
  }
  const tabs = await listTabsOrdered(sb, ucDoc.id);
  const has = tabs.some((t) => t.title === TAB_TITLE);
  if (has) {
    already++;
    console.log(`  · ${s.student_name.padEnd(24)} already has "${TAB_TITLE}" (${tabs.length} tab(s)) — skip`);
    continue;
  }
  if (WRITE) {
    await seedDefaultTab(sb, ucDoc.id, TAB_TITLE, student);
    created++;
    console.log(`  ✓ ${s.student_name.padEnd(24)} seeded "${TAB_TITLE}" (had ${tabs.length} tab(s))`);
  } else {
    created++;
    console.log(`  + ${s.student_name.padEnd(24)} WOULD seed "${TAB_TITLE}" (has ${tabs.length} tab(s))`);
  }
}

console.log(
  `\n${WRITE ? '✓ Seeded' : 'Would seed'} ${created} · already had ${already} · ${seniors.length} total.`
);
