/**
 * seedSeniorWriting.mjs — pre-create the writing docs for EVERY Class-of-2027
 * senior so their Common App main essay + UC PIQ (+ Supplemental) docs already
 * exist (instead of being lazily created the first time they open Colleges).
 * Runs the SAME lib path GET /api/writing uses, so it's idempotent and stays in
 * lockstep with the live behavior. PIQ/supplement tabs sync from the student's
 * mirrored college list when one exists; otherwise the docs + the Common App
 * "Personal Statement" tab are still created.
 *
 *   node scripts/seedSeniorWriting.mjs            # dry run (report, no writes)
 *   node scripts/seedSeniorWriting.mjs --write    # create the docs/tabs
 */
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import {
  ensureDocuments,
  ensureSingletonTab,
  syncTabs,
  listTabsOrdered,
  entriesFromCollegeList,
} from '../lib/writingDocs.js';

const WRITE = process.argv.includes('--write');

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

console.log(`${seniors.length} senior(s)${WRITE ? '' : ' (DRY RUN — pass --write to create)'}\n`);

let done = 0;
for (const s of seniors) {
  const student = { email: s.student_email, name: s.student_name };
  if (!WRITE) {
    const { data: existing } = await sb
      .from('md_documents')
      .select('doc_type')
      .eq('student_sheet_id', s.student_sheet_id);
    const have = (existing || []).map((d) => d.doc_type).sort().join(',') || 'none';
    console.log(`  • ${s.student_name.padEnd(22)} existing docs: ${have}`);
    continue;
  }
  const { data: mirror } = await sb
    .from('student_college_lists')
    .select('payload')
    .eq('student_sheet_id', s.student_sheet_id)
    .maybeSingle();
  const docs = await ensureDocuments(sb, s.student_sheet_id, s.student_email);
  const { piq, supplemental } = entriesFromCollegeList(mirror?.payload || {});
  await ensureSingletonTab(sb, docs.COMMON_APP.id, 'Personal Statement', student);
  await syncTabs(sb, docs.UC_PIQ.id, piq, student);
  await syncTabs(sb, docs.SUPPLEMENTAL.id, supplemental, student);
  const ca = await listTabsOrdered(sb, docs.COMMON_APP.id);
  const uc = await listTabsOrdered(sb, docs.UC_PIQ.id);
  const sup = await listTabsOrdered(sb, docs.SUPPLEMENTAL.id);
  console.log(
    `  ✓ ${s.student_name.padEnd(22)} CommonApp(${ca.length}) UC_PIQ(${uc.length}) Supp(${sup.length})`
  );
  done++;
}

if (WRITE) console.log(`\n✓ Seeded ${done} senior(s) (idempotent).`);
