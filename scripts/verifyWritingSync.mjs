/**
 * verifyWritingSync.mjs — exercises the writing-platform sync logic against the
 * REAL student-hubs Supabase tables, using a clearly-fake student id that it
 * deletes at the end. Validates: idempotency (no churn), rename-safety,
 * orphan-to-bottom on college removal, content-preserving re-add, and
 * WHO-edited append-only revisions.
 *
 *   node scripts/verifyWritingSync.mjs
 */
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import {
  ensureDocuments,
  ensureSingletonTab,
  syncTabs,
  listTabsOrdered,
  appendRevision,
  getTabBody,
  getTabHistory,
  entriesFromCollegeList,
} from '../lib/writingDocs.js'

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

const FAKE = 'verify-sync-fake-sheet-DELETE-ME'
const STUDENT = { email: 'fake.student@example.com', name: 'Fake Student', role: 'student' }
const AARON = { email: 'aaron@sapientacademy.com', name: 'Aaron', role: 'admin' }

let pass = 0,
  fail = 0
const ok = (cond, msg) => {
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${msg}`)
  cond ? pass++ : fail++
}

async function cleanup() {
  const { data: docs } = await sb.from('md_documents').select('id').eq('student_sheet_id', FAKE)
  for (const d of docs || []) await sb.from('md_documents').delete().eq('id', d.id) // cascades
}

async function titles(docId) {
  return (await listTabsOrdered(sb, docId)).map((t) => ({
    title: t.title,
    state: t.sync_state,
    id: t.id,
  }))
}

await cleanup()

// 1. documents
const docs = await ensureDocuments(sb, FAKE, STUDENT.email)
ok(docs.COMMON_APP && docs.UC_PIQ && docs.SUPPLEMENTAL, 'ensureDocuments created all 3 docs')
const supDoc = docs.SUPPLEMENTAL.id

// 2. initial sync — 3 colleges
const list1 = ['Harvard', 'Yale', 'MIT']
await syncTabs(sb, supDoc, list1.map((n) => ({ key: n.toLowerCase(), title: n })), STUDENT)
let t = await titles(supDoc)
ok(
  t.length === 3 && t.every((x) => x.state === 'active'),
  `3 active tabs after first sync (${t.map((x) => x.title).join(', ')})`
)
const harvardId = t.find((x) => x.title === 'Harvard').id

// 3. idempotency — same list, no churn (ids + order stable)
await syncTabs(sb, supDoc, list1.map((n) => ({ key: n.toLowerCase(), title: n })), STUDENT)
let t2 = await titles(supDoc)
ok(
  JSON.stringify(t.map((x) => x.id)) === JSON.stringify(t2.map((x) => x.id)),
  'second identical sync is a no-op (tab ids + order unchanged)'
)

// 4. rename safety — user renames the Harvard tab; sync must not revert/fork it
await sb.from('md_tabs').update({ title: 'Harvard - REA' }).eq('id', harvardId)
await syncTabs(sb, supDoc, list1.map((n) => ({ key: n.toLowerCase(), title: n })), STUDENT)
let t3 = await titles(supDoc)
const stillHarvard = t3.find((x) => x.id === harvardId)
ok(
  stillHarvard && stillHarvard.title === 'Harvard - REA' && t3.length === 3,
  'rename survives sync (same id, title kept "Harvard - REA", no duplicate)'
)

// 5. seed content into Harvard, then remove Harvard from the list → orphan to bottom, content kept
await appendRevision(sb, harvardId, '# Harvard essay draft\n\nMy why-Harvard.', STUDENT, 'edit', null)
await syncTabs(sb, supDoc, ['Yale', 'MIT'].map((n) => ({ key: n.toLowerCase(), title: n })), STUDENT)
let t4 = await titles(supDoc)
const orphan = t4.find((x) => x.id === harvardId)
ok(orphan && orphan.state === 'orphaned', 'removed college → tab orphaned (not deleted)')
ok(t4[t4.length - 1].id === harvardId, 'orphaned tab moved to the BOTTOM')
const body = await getTabBody(sb, harvardId)
ok(body && /Harvard essay draft/.test(body.body_md), 'orphaned tab content preserved')

// 6. re-add Harvard → revived active, same id, content intact
await syncTabs(sb, supDoc, list1.map((n) => ({ key: n.toLowerCase(), title: n })), STUDENT)
let t5 = await titles(supDoc)
const revived = t5.find((x) => x.id === harvardId)
ok(revived && revived.state === 'active', 're-added college revives the SAME tab as active')
const body2 = await getTabBody(sb, harvardId)
ok(body2 && /Harvard essay draft/.test(body2.body_md), 'revived tab still has its content')

// 7. WHO-edited — admin edits, history shows both authors
await appendRevision(sb, harvardId, '# Harvard essay draft v2', AARON, 'edit', 'tightened intro')
const hist = await getTabHistory(sb, harvardId)
const roles = new Set(hist.map((h) => h.editor_role))
ok(roles.has('student') && roles.has('admin'), 'history records both student and admin edits')
ok(
  hist[0].editor_name === 'Aaron' && hist[0].revision > 0,
  `latest revision attributed to Aaron (rev ${hist[0].revision})`
)

// 8. singleton (Common App) + PIQ entries from a college-list payload
await ensureSingletonTab(sb, docs.COMMON_APP.id, 'Personal Statement', STUDENT)
const caTabs = await listTabsOrdered(sb, docs.COMMON_APP.id)
ok(caTabs.length === 1 && caTabs[0].title === 'Personal Statement', 'Common App has a single tab')
const { piq, supplemental } = entriesFromCollegeList({
  schools: [{ name: 'Harvard' }, { name: 'Yale' }],
  piqs: [{ prompt: 'Leadership?', chosen: true }, { prompt: 'Creative?', chosen: false }, { prompt: 'Talent?', chosen: true }],
})
ok(piq.length === 2 && piq[0].key === 'piq-1' && piq[1].key === 'piq-3', 'entriesFromCollegeList picks chosen PIQs with stable keys')
ok(supplemental.length === 2 && supplemental[0].key === 'harvard', 'entriesFromCollegeList builds supplement keys')

await cleanup()
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
