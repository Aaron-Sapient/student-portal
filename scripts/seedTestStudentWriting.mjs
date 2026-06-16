/**
 * seedTestStudentWriting.mjs — seed (and inspect) the Test Student's 3 writing
 * docs from his mirrored college list, running the SAME lib path GET /api/writing
 * uses. Idempotent. Run mirrorCollegeLists.cjs first so the mirror row exists.
 *
 *   node scripts/seedTestStudentWriting.mjs
 */
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import {
  ensureDocuments,
  ensureSingletonTab,
  syncTabs,
  listTabsOrdered,
  entriesFromCollegeList,
} from '../lib/writingDocs.js'

const TEST_STUDENT = '1UW-RSqv30c_BUdv9nfm48YVVs7L-UmWKsYn_jXhYt6w'

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

const { data: mirror } = await sb
  .from('student_college_lists')
  .select('payload,student_email')
  .eq('student_sheet_id', TEST_STUDENT)
  .maybeSingle()
if (!mirror) {
  console.error('No mirror row — run: node scripts/mirrorCollegeLists.cjs')
  process.exit(1)
}
const student = { email: mirror.student_email || 'test.student@portal', name: 'Test Student' }

const docs = await ensureDocuments(sb, TEST_STUDENT, student.email)
const { piq, supplemental } = entriesFromCollegeList(mirror.payload)

await ensureSingletonTab(sb, docs.COMMON_APP.id, 'Personal Statement', student)
await syncTabs(sb, docs.UC_PIQ.id, piq, student)
await syncTabs(sb, docs.SUPPLEMENTAL.id, supplemental, student)

const LABEL = { COMMON_APP: 'Common App', UC_PIQ: 'UC PIQs', SUPPLEMENTAL: 'Supplements' }
for (const type of ['COMMON_APP', 'UC_PIQ', 'SUPPLEMENTAL']) {
  const tabs = await listTabsOrdered(sb, docs[type].id)
  console.log(`\n${LABEL[type]}  (${tabs.length} tab${tabs.length === 1 ? '' : 's'})`)
  for (const t of tabs) {
    console.log(`  • ${t.title}${t.sync_state === 'orphaned' ? '  [orphaned→bottom]' : ''}`)
  }
}
console.log('\nSeed complete (idempotent).')
