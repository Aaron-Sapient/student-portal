/**
 * seedDemoWritingDocs.mjs — put the /demo board's sample documents into Supabase
 * as REAL writing tabs, so a family clicking "Personal statement, draft 4" opens
 * the product's own /write editor rather than a copy of it.
 *
 *   node scripts/seedDemoWritingDocs.mjs           # dry run, prints the plan
 *   node scripts/seedDemoWritingDocs.mjs --commit  # write, then emit writeLinks.json
 *
 * WHY A SYNTHETIC STUDENT, not the Test Student. The Test Student was the obvious
 * host and is the wrong one: that fixture already holds Aaron's real work (27 revisions on the
 * personal statement, 52 on the Harvard supplement), and dropping Maya Ellison's
 * fictional drafts in beside them would both pollute the fixture and put Harvard,
 * Yale and Princeton in the tab rail of a demo about Duke.
 *
 * WHY COMMON_APP FOR ALL SIX. app/api/writing/doc/route.js re-syncs a UC_PIQ or
 * SUPPLEMENTAL doc against the student's college-list mirror on every read. This
 * student has no mirror row, so that sync would run against an empty list every
 * time the page opened. COMMON_APP is the one type the route explicitly leaves
 * alone ("no list to sync against"), which makes it the only stable home for a
 * hand-authored set of tabs.
 *
 * WHY THE ROSTER ROW IS status 'nc'. md_documents carries a foreign key to
 * students(student_sheet_id) that the checked-in writing_schema.sql does not
 * mention, so a document set genuinely owned by nobody is not possible; the
 * synthetic student needs a roster row. 'nc' (not continuing) is the existing
 * inactive state and makes the row inert: every consumer filters status='active'
 * (lib/identity.js:131, 146, 242), nothing in the repo ever DELETEs from
 * students, and backfillStudents.cjs:219 sets exactly this status for anyone
 * missing from the Master sheet -- so the nightly backfill re-affirms the row
 * rather than fighting it. The cost is that studentBySheetIdFromSupabase also
 * filters on 'active', so /write shows the neutral "Student" rather than a name.
 * That is the right trade: a fake ACTIVE student would reach the omnibar, the
 * scoring cron and the compliance audits.
 *
 * Idempotent: re-running matches existing tabs by title and rewrites a body only
 * when it actually differs, so revision history does not grow on a no-op run.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { SAMPLE_DOCS } from '../app/demo/sampleDocs.js'

const DEMO_SHEET_ID = 'DEMO-FAMILY-PORTAL'
const DEMO_EMAIL = 'demo@portal'
const EDITOR = { email: DEMO_EMAIL, name: 'Sample', role: 'admin' }

const COMMIT = process.argv.includes('--commit')

const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]
    })
)
const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

/* ── the roster row the foreign key requires ────────────────────────────── */

const { data: existingStudent } = await sb
  .from('students')
  .select('student_sheet_id,status')
  .eq('student_sheet_id', DEMO_SHEET_ID)
  .maybeSingle()

if (!existingStudent) {
  console.log(`student: CREATE  ${DEMO_SHEET_ID}  status=nc`)
  if (COMMIT) {
    const { error } = await sb.from('students').insert({
      student_sheet_id: DEMO_SHEET_ID,
      name: 'Maya Ellison (sample)',
      class: "'27",
      grade: '12th',
      student_email: DEMO_EMAIL,
      status: 'nc',
      slug: 'demo-family-portal',
    })
    if (error) throw error
  }
} else {
  console.log(`student: exists  status=${existingStudent.status}`)
}

/* ── the document ───────────────────────────────────────────────────────── */

let { data: doc } = await sb
  .from('md_documents')
  .select('id')
  .eq('student_sheet_id', DEMO_SHEET_ID)
  .eq('doc_type', 'COMMON_APP')
  .maybeSingle()

if (!doc) {
  console.log(`document: CREATE  ${DEMO_SHEET_ID} / COMMON_APP`)
  if (COMMIT) {
    const { data, error } = await sb
      .from('md_documents')
      .insert({
        student_sheet_id: DEMO_SHEET_ID,
        student_email: DEMO_EMAIL,
        doc_type: 'COMMON_APP',
      })
      .select('id')
      .single()
    if (error) throw error
    doc = data
  }
} else {
  console.log(`document: exists  ${doc.id}`)
}

/* ── the tabs ───────────────────────────────────────────────────────────── */

const links = {}

for (const [i, d] of SAMPLE_DOCS.entries()) {
  const title = d.name
  let tab = null

  if (doc) {
    const { data } = await sb
      .from('md_tabs')
      .select('id')
      .eq('document_id', doc.id)
      .eq('title', title)
      .maybeSingle()
    tab = data
  }

  if (!tab) {
    console.log(`  tab CREATE   "${title}"`)
    if (COMMIT) {
      const { data, error } = await sb
        .from('md_tabs')
        .insert({
          document_id: doc.id,
          title,
          origin: 'manual',
          sync_state: 'manual_active',
          sort_key: (i + 1) * 100,
        })
        .select('id')
        .single()
      if (error) throw error
      tab = data
    }
  } else {
    console.log(`  tab exists   "${title}"  ${tab.id}`)
  }

  if (tab) {
    // Current body = latest revision. Only append when the text actually changed.
    const { data: latest } = await sb
      .from('md_tab_revisions')
      .select('revision,body_md')
      .eq('tab_id', tab.id)
      .order('revision', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!latest) {
      console.log(`    body  BASELINE (${d.body.length} chars)`)
      if (COMMIT) {
        const { error } = await sb.from('md_tab_revisions').insert({
          tab_id: tab.id,
          revision: 1,
          body_md: d.body,
          source: 'baseline',
          editor_email: EDITOR.email,
          editor_role: EDITOR.role,
          editor_name: EDITOR.name,
          note: 'demo seed',
        })
        if (error) throw error
      }
    } else if (latest.body_md !== d.body) {
      console.log(`    body  UPDATE   rev ${latest.revision + 1}`)
      if (COMMIT) {
        const { error } = await sb.from('md_tab_revisions').insert({
          tab_id: tab.id,
          revision: latest.revision + 1,
          body_md: d.body,
          source: 'edit',
          editor_email: EDITOR.email,
          editor_role: EDITOR.role,
          editor_name: EDITOR.name,
          note: 'demo seed',
        })
        if (error) throw error
      }
    } else {
      console.log(`    body  unchanged`)
    }

    links[d.id] = { docId: doc.id, tabId: tab.id }
  }
}

/* ── the link map the board reads ───────────────────────────────────────── */

if (COMMIT && doc) {
  const out = new URL('../app/demo/writeLinks.json', import.meta.url)
  writeFileSync(out, JSON.stringify(links, null, 2) + '\n')
  console.log(`\nwrote app/demo/writeLinks.json (${Object.keys(links).length} links)`)
  console.log(`open: /write/${doc.id}`)
} else if (!COMMIT) {
  console.log('\nDry run. Nothing written. Re-run with --commit.')
}
