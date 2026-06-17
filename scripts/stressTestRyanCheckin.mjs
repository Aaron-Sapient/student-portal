/**
 * stressTestRyanCheckin.mjs — force the Ryan summer check-in "meeting request"
 * email for Test Student, bypassing the Claude urgency eval entirely.
 *
 * It sends the REAL email (lib/checkinEmails → sendRyanMeetingRequestEmail) to
 * ryan@sapientacademy.com, one-time CC aaron@sapientacademy.com, with three
 * working HMAC-signed Grant-15 / Grant-30 / Reject buttons pointed at production
 * (https://portal.admissions.partners). Clicking them exercises the real
 * /checkin-approval → /api/checkinDecision loop.
 *
 * SAFE BY DEFAULT. With no flag it only INSPECTS (read-only): finds Test Student,
 * prints the Grant blast-radius (Master J/K/L emails a grant would notify) and
 * current AZ, discovers which secret prod verifies tokens with, and confirms a
 * token validates against prod's GET confirm page (which never mutates). It does
 * NOT write the sheet or send mail. Pass --send to ram the check-in through
 * (append CheckinForm row + set Master AZ='pending') and actually email Ryan.
 *
 *   node scripts/stressTestRyanCheckin.mjs            # dry run / inspect only
 *   node scripts/stressTestRyanCheckin.mjs --send     # ram through + email Ryan
 */
import { readFileSync } from 'node:fs'
import { google } from 'googleapis'

const TEST_STUDENT_SHEET_ID = '1UW-RSqv30c_BUdv9nfm48YVVs7L-UmWKsYn_jXhYt6w'
const PROD_BASE_URL = 'https://portal.admissions.partners'
const MASTER_TAB = '👩‍🎓 All Data'
const CHECKIN_TAB = 'CheckinForm'
const RYAN = 'ryan@sapientacademy.com'
const CC_AARON = 'aaron@sapientacademy.com'

const SEND = process.argv.includes('--send')

// ── load .env.local into process.env (lib code reads process.env at call time) ─
const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]
    })
)
for (const [k, v] of Object.entries(env)) process.env[k] ??= v
// The .env.local NEXT_PUBLIC_BASE_URL points at a now-dead Vercel preview (HTTP
// 410); force the verified-live prod domain so the buttons actually work.
process.env.NEXT_PUBLIC_BASE_URL = PROD_BASE_URL

const sheetIdFromPortalUrl = (url) => {
  const m = String(url ?? '').match(/\/d\/([a-zA-Z0-9-_]+)/)
  return m ? m[1] : null
}

function getSheets() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  })
  return google.sheets({ version: 'v4', auth })
}

// Read-only probe: does prod's GET confirm page accept a token minted with this
// secret? The GET page verifies the signature and renders the decision; it never
// mutates (mutation is POST-only), so this is safe to call repeatedly.
async function prodAcceptsToken(token) {
  try {
    const res = await fetch(`${PROD_BASE_URL}/checkin-approval?t=${encodeURIComponent(token)}`, {
      signal: AbortSignal.timeout(15000),
    })
    const body = await res.text()
    if (/no longer valid/i.test(body)) return false
    return /meeting decision|Grant a 1|Decline a meeting/i.test(body)
  } catch (e) {
    console.error('  probe error:', e.message)
    return false
  }
}

async function main() {
  const { makeApprovalToken } = await import('../lib/checkinApproval.js')

  const sheets = getSheets()

  // ── 1. Find Test Student in the Master roster ───────────────────────────────
  const masterRes = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.MASTER_SHEET_ID,
    range: `'${MASTER_TAB}'!A:BD`,
  })
  const rows = masterRes.data.values || []
  let idx = rows.findIndex((r) => sheetIdFromPortalUrl(r?.[6]) === TEST_STUDENT_SHEET_ID)
  if (idx === -1) idx = rows.findIndex((r) => String(r?.[0] ?? '').trim() === 'Test Student')
  if (idx === -1) {
    console.error('✗ Could not find Test Student in the Master sheet.')
    process.exit(1)
  }
  const r = rows[idx]
  const masterRow = idx + 1 // 1-based sheet row
  const studentName = String(r[0] ?? '').trim()
  const sheetId = sheetIdFromPortalUrl(r[6]) || TEST_STUDENT_SHEET_ID
  const studentEmail = String(r[9] ?? '').trim()
  const parentEmails = [r[10], r[11]].map((e) => String(e ?? '').trim()).filter(Boolean)
  const currentAZ = String(r[51] ?? '').trim()

  console.log('\n── Test Student (Master row) ──────────────────────────────')
  console.log('  name            :', studentName)
  console.log('  master row      :', masterRow)
  console.log('  sheetId         :', sheetId)
  console.log('  current AZ      :', currentAZ || '(blank)')
  console.log('\n── Blast radius of a "Grant" click (emails Master J/K/L) ──')
  console.log('  student (J)     :', studentEmail || '(blank — no student email would send)')
  console.log('  parents (K/L)   :', parentEmails.length ? parentEmails.join(', ') : '(none)')

  // ── 2. Discover which secret prod verifies approval tokens with ─────────────
  console.log('\n── Secret discovery (read-only GET against prod) ──────────')
  const candidates = [
    ['CLERK_SECRET_KEY_PROD', env.CLERK_SECRET_KEY_PROD],
    ['CLERK_SECRET_KEY', env.CLERK_SECRET_KEY],
    ['CHECKIN_APPROVAL_SECRET', env.CHECKIN_APPROVAL_SECRET],
  ].filter(([, v]) => v)
  let winner = null
  for (const [label, secret] of candidates) {
    process.env.CHECKIN_APPROVAL_SECRET = secret // getSecret() prefers this
    const probe = makeApprovalToken({ action: 'grant15', masterRow, checkinRow: masterRow, studentSheetId: sheetId, studentName })
    const ok = await prodAcceptsToken(probe)
    console.log(`  ${ok ? '✓' : '✗'} ${label}`)
    if (ok) { winner = secret; break }
  }
  if (!winner) {
    console.error('\n✗ No local secret produced a token prod accepts. Prod is likely using a')
    console.error('  CHECKIN_APPROVAL_SECRET set only in Vercel. Buttons would 401 ("Invalid')
    console.error('  or expired link"). Aborting — get that secret before sending.')
    process.exit(1)
  }
  process.env.CHECKIN_APPROVAL_SECRET = winner

  if (!SEND) {
    console.log('\n── DRY RUN (no --send) ────────────────────────────────────')
    console.log('  Nothing written, no email sent. Everything checks out above:')
    console.log('  buttons would point at', PROD_BASE_URL, 'and validate against prod.')
    console.log('  Re-run with  --send  to ram the check-in through and email Ryan.')
    return
  }

  // ── 3. Ram the check-in through: append CheckinForm row + set AZ='pending' ──
  const now = new Date().toISOString()
  const selfRating = 3
  const qCategory = 'Need to Discuss'
  const qText = 'Feeling stuck on my Comps research project and behind where I wanted to be by now.'
  const tests = 'SAT registration deadline next week'
  const tasksStr = 'Independent Research Project: In Progress (~35%); Draft personal statement: Not Started'

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.MASTER_SHEET_ID,
    range: `${CHECKIN_TAB}!A:I`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [[now, studentName, '', tests, tasksStr, qCategory, qText, String(selfRating), '']],
    },
  })

  // locate the row we just appended (last row whose col B === studentName)
  const ckRes = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.MASTER_SHEET_ID,
    range: `${CHECKIN_TAB}!A:L`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  })
  const ckRows = ckRes.data.values || []
  let lastMatch = -1
  ckRows.forEach((row, i) => { if (row[1] === studentName) lastMatch = i })
  const checkinRow = lastMatch + 1

  const reason =
    'Test Student rated the week 3/10 and flagged a Need-to-Discuss concern about a Comps project that is behind schedule — worth a quick 15. (Heads up: this is a stress-test of the new approval email using the Test Student record.)'

  // K=reason, L=status('pending'); Master AZ='pending' (the booking gate)
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: process.env.MASTER_SHEET_ID,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data: [
        { range: `${CHECKIN_TAB}!K${checkinRow}`, values: [[reason]] },
        { range: `${CHECKIN_TAB}!L${checkinRow}`, values: [['pending']] },
        { range: `'${MASTER_TAB}'!AZ${masterRow}`, values: [['pending']] },
      ],
    },
  })

  // ── 4. Mint the three real tokens + send the real email ─────────────────────
  const base = { masterRow, checkinRow, studentSheetId: sheetId, studentName }
  const tokens = {
    grant15: makeApprovalToken({ ...base, action: 'grant15' }),
    grant30: makeApprovalToken({ ...base, action: 'grant30' }),
    reject: makeApprovalToken({ ...base, action: 'reject' }),
  }

  // belt-and-suspenders: confirm the real grant token validates against prod
  const realOk = await prodAcceptsToken(tokens.grant15)
  if (!realOk) {
    console.error('✗ Real token failed prod validation after writing the row. Aborting send.')
    console.error('  (CheckinForm row', checkinRow, 'and Master AZ are now "pending" — reset if needed.)')
    process.exit(1)
  }

  const signals = [
    `Self-rating: ${selfRating}/10`,
    `Concern (${qCategory}): ${qText}`,
    `Tests/deadlines: ${tests}`,
    'Behind schedule: Independent Research Project (35%)',
  ]

  const { sendRyanMeetingRequestEmail } = await import('../lib/checkinEmails.js')
  await sendRyanMeetingRequestEmail({
    studentName,
    reason,
    suggestedLength: '15min',
    signals,
    tokens,
    to: RYAN,
    cc: CC_AARON,
  })

  console.log('\n✓ SENT.')
  console.log('  to            :', RYAN)
  console.log('  cc            :', CC_AARON, '(one-time)')
  console.log('  buttons       :', PROD_BASE_URL + '/checkin-approval?t=…  (validated against prod)')
  console.log('  CheckinForm   : row', checkinRow, '(K=reason, L=pending)')
  console.log('  Master AZ     : row', masterRow, '= pending')
  console.log('\n  Clicking Grant-15/30 → emails', studentEmail || '(no student email on file)',
    parentEmails.length ? `(CC ${parentEmails.join(', ')})` : '', '+ books a token.')
  console.log('  Clicking Reject → generates a written report, no student email.')
  console.log('\n  Undo (reset Test Student): set Master AZ row', masterRow, 'back to blank/"written".')
}

main().catch((e) => { console.error(e); process.exit(1) })
