/**
 * healMdMetaLines.mjs — ONE-TIME repair for the %%ind:/font corruption bug (fixed in
 * md-editor v1.2.0, 2026-07-16). Pre-fix, applying a font/bold/etc. across a selection
 * that spanned a hidden machine-managed directive line (%%ind:N%%, %%doc:…%%, %%cols:…%%)
 * wrapped it in style/emphasis marks (`@{s:f=times}%%ind:1%%@{/s}`), demoting it to a
 * visible paragraph that leaks raw %%…%% syntax (and, for %%cols:, drops table widths).
 *
 *   node scripts/healMdMetaLines.mjs            # DRY RUN: scan every tab's latest revision
 *   node scripts/healMdMetaLines.mjs --apply    # append a healed revision per affected tab
 *
 * Storage model: the canonical body is the MAX(revision) row of md_tab_revisions
 * (append-only, attributed). So the repair APPENDS a new revision per affected tab via
 * lib/writingDocs.appendRevision (source 'edit', editor "System · directive repair") —
 * it never UPDATEs history in place. Residual: restoring a pre-repair revision can
 * resurrect the corruption; the v1.2.0 engine fix prevents it from spreading, and
 * read-only viewers no longer reveal it either way.
 *
 * Run AFTER the v1.2.0 engine is deployed (a live pre-fix editor session could re-save
 * its in-memory corrupted body right over the healed revision) — then re-run the dry
 * scan to confirm zero findings.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// .env.local → process.env (only the two keys getSupabaseClient reads)
{
  const env = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
  for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) {
    const m = env.match(new RegExp('^' + k + '=(.*)$', 'm'));
    if (m && !process.env[k]) process.env[k] = m[1].replace(/^['"]|['"]$/g, '');
  }
}

const { getSupabaseClient, MD_DOCUMENTS, MD_TABS, MD_TAB_REVISIONS } = await import(
  '../lib/supabase.js'
);
const { appendRevision } = await import('../lib/writingDocs.js');

const APPLY = process.argv.includes('--apply');

// A clean machine-managed directive line — the ONLY thing we ever commit an unwrap to.
// Deliberately narrow (ind/doc/cols, the render()-hidden set): no generic %%…%% healing,
// so no legitimate user line can ever be rewritten.
const DIRECTIVE = /^\s*%%(?:ind|doc|cols):[^%\n]*%%\s*$/;
// One outermost wrap layer, either kind. Peeled iteratively; the unwrap is committed
// ONLY if the fully-peeled residue is a clean directive (gate above) — a blind peel of
// `.+` would otherwise unwrap legitimate styled lines.
const STYLE_WRAP = /^(\s*)@\{s:[^}]*\}(.+)@\{\/s\}(\s*)$/;
const EMPH_WRAP = /^(\s*)(\*\*\*|\*\*|\*|___|__|_|~~|`)(.+)\2(\s*)$/;

function healLine(ln) {
  if (DIRECTIVE.test(ln)) return ln; // already clean
  let cur = ln;
  for (let guard = 0; guard < 8; guard++) {
    let m;
    if ((m = STYLE_WRAP.exec(cur))) { cur = m[1] + m[2] + m[3]; continue; }
    if ((m = EMPH_WRAP.exec(cur))) { cur = m[1] + m[3] + m[4]; continue; }
    break;
  }
  return cur !== ln && DIRECTIVE.test(cur) ? cur : ln;
}

function healBody(body) {
  const lines = String(body ?? '').split('\n');
  const changes = [];
  const healed = lines.map((ln, i) => {
    const h = healLine(ln);
    if (h !== ln) changes.push({ line: i + 1, before: ln, after: h });
    return h;
  });
  return { healed: healed.join('\n'), changes };
}

const sb = getSupabaseClient();

const { data: docs, error: docErr } = await sb
  .from(MD_DOCUMENTS)
  .select('id,doc_type,student_email,student_sheet_id');
if (docErr) throw new Error('md_documents query failed: ' + docErr.message);
const docById = new Map(docs.map((d) => [d.id, d]));

const { data: tabs, error: tabErr } = await sb
  .from(MD_TABS)
  .select('id,title,document_id');
if (tabErr) throw new Error('md_tabs query failed: ' + tabErr.message);

console.log(
  `${APPLY ? 'APPLY' : 'DRY RUN'} — scanning latest revision of ${tabs.length} tabs across ${docs.length} documents\n`
);

let affectedTabs = 0,
  totalLines = 0,
  applied = 0,
  failures = 0;

for (const tab of tabs) {
  const { data: rev, error: revErr } = await sb
    .from(MD_TAB_REVISIONS)
    .select('revision,body_md')
    .eq('tab_id', tab.id)
    .order('revision', { ascending: false })
    .limit(1);
  if (revErr) {
    console.error(`  !! tab ${tab.id} ("${tab.title}") revision query failed: ${revErr.message}`);
    failures++;
    continue;
  }
  if (!rev?.length) continue; // tab with no revisions yet

  const { healed, changes } = healBody(rev[0].body_md);
  if (!changes.length) continue;

  affectedTabs++;
  totalLines += changes.length;
  const doc = docById.get(tab.document_id);
  console.log(
    `• ${doc?.student_email ?? '?'} — ${doc?.doc_type ?? '?'} / "${tab.title}" (tab ${tab.id}, rev ${rev[0].revision})`
  );
  for (const c of changes) {
    console.log(`    L${c.line}: ${JSON.stringify(c.before)}`);
    console.log(`      → ${JSON.stringify(c.after)}`);
  }

  if (APPLY) {
    const res = await appendRevision(
      sb,
      tab.id,
      healed,
      { email: 'system@portal', role: 'admin', name: 'System · directive repair' },
      'edit',
      'One-time unwrap of style/emphasis-wrapped %%ind:/%%doc:/%%cols: directive lines (md-editor v1.2.0 corruption fix, 2026-07-16)'
    );
    if (res?.revision != null) {
      console.log(`    ✓ appended healed revision ${res.revision}`);
      applied++;
    } else {
      console.error(`    !! append FAILED: ${res?.error ?? 'unknown'}`);
      failures++;
    }
  }
}

console.log(
  `\n${APPLY ? 'APPLY' : 'DRY RUN'} complete: ${affectedTabs} affected tabs, ${totalLines} corrupted lines` +
    (APPLY ? `, ${applied} healed revisions appended` : '') +
    (failures ? `, ${failures} FAILURES` : '')
);
if (!APPLY && affectedTabs) console.log('Re-run with --apply to append healed revisions.');
process.exit(failures ? 1 : 0);
