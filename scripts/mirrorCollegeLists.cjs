/**
 * mirrorCollegeLists.cjs — one-way mirror of each senior's 🏫 College List from
 * their Google Sheet into the Supabase `student_college_lists` table. The portal
 * reads the college list from Supabase (fast, no live-Sheets quota on the hot
 * path) and the writing platform syncs supplement/PIQ tabs from it.
 *
 * This is the body of the NAS cron (one-way Sheets→Supabase mirror, per the
 * ratified migration plan). Runnable on the Mac for seeding:
 *
 *   node scripts/mirrorCollegeLists.cjs                 # TEST student only
 *   node scripts/mirrorCollegeLists.cjs <SHEET_ID>      # one student
 *   node scripts/mirrorCollegeLists.cjs --all           # every non-NC student
 *
 * Idempotent: upsert on student_sheet_id. Read-only against Google.
 */
const fs = require('fs')
const path = require('path')
const { google } = require('googleapis')
const { createClient } = require('@supabase/supabase-js')

const TEST_STUDENT = '1UW-RSqv30c_BUdv9nfm48YVVs7L-UmWKsYn_jXhYt6w'
const MASTER_TAB = "'👩‍🎓 All Data'"

function loadEnv() {
  const env = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8')
  return (k) => {
    const m = env.match(new RegExp('^' + k + '=(.*)$', 'm'))
    return m ? m[1].replace(/^['"]|['"]$/g, '') : null
  }
}

async function main() {
  const get = loadEnv()
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: get('GOOGLE_SERVICE_ACCOUNT_EMAIL'),
      private_key: get('GOOGLE_PRIVATE_KEY').replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  })
  const sheets = google.sheets({ version: 'v4', auth })
  const sb = createClient(get('SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false },
  })
  // Read the SHEETS path directly (not the flag-aware fetchCollegeData dispatcher):
  // this is the WRITER for the Supabase mirror, so it must always read Google
  // Sheets regardless of READ_SUPABASE_COLLEGES — otherwise once that flag is `on`
  // the mirror would read Supabase and write it back to itself (circular no-op).
  const { fetchCollegeDataFromSheets } = await import('../lib/collegeList.js')

  const args = process.argv.slice(2)
  const ALL = args.includes('--all')

  // Master roster → sheetId → { name, email, class } (for student_email + scope).
  const master =
    (
      await sheets.spreadsheets.values.get({
        spreadsheetId: get('MASTER_SHEET_ID'),
        range: `${MASTER_TAB}!A:L`,
      })
    ).data.values || []
  const bySheet = {}
  for (const r of master) {
    const m = String(r[6] || '').match(/\/d\/([a-zA-Z0-9-_]+)/)
    if (m) {
      bySheet[m[1]] = {
        name: String(r[0] || '').trim(),
        email: String(r[9] || '').trim().toLowerCase(),
        cls: String(r[1] || '').trim().toUpperCase(),
      }
    }
  }

  const targets = ALL
    ? Object.keys(bySheet).filter((id) => bySheet[id].cls !== 'NC')
    : [args.find((a) => !a.startsWith('--')) || TEST_STUDENT]

  let okCount = 0
  for (const sheetId of targets) {
    let payload
    try {
      payload = await fetchCollegeDataFromSheets(sheets, sheetId)
    } catch (e) {
      console.log(`✗  ${sheetId}: read failed — ${e.message}`)
      continue
    }
    if (!payload) {
      console.log(`—  ${sheetId} (${bySheet[sheetId]?.name || '?'}): no College List, skipped`)
      continue
    }
    const info = bySheet[sheetId] || {}
    const { error } = await sb.from('student_college_lists').upsert(
      {
        student_sheet_id: sheetId,
        student_email: info.email || null,
        payload,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'student_sheet_id' }
    )
    if (error) {
      console.log(`✗  ${sheetId}: ${error.message}`)
    } else {
      okCount++
      const chosen = (payload.piqs || []).filter((p) => p.chosen).length
      console.log(
        `✓  ${sheetId} (${info.name || '?'}): ${payload.schools?.length || 0} schools, ${chosen} PIQs chosen`
      )
    }
  }
  console.log(`\n${okCount} mirrored.`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
