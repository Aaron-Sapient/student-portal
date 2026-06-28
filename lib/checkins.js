import { DateTime } from 'luxon'
import { getSupabaseClient } from '@/lib/supabase'
import { readMode, logShadow } from '@/lib/readFlags'
import { cellToISODate } from '@/app/api/developer/studentScores/shared'

// Flag-aware readers for the two DEV check-in RECENCY surfaces (Sheets→Supabase
// read cutover, domain `checkins`):
//   • getCheckinTimeline  — the per-student scoring page's check-in tick list
//                           ([{date,who}] sorted asc), used by the [sheetId] route.
//   • readLatestCheckins  — the Students-tab compliance pill's Map<normName,latestISO>,
//                           used by the developer/roster route.
// Modeled byte-for-byte on lib/scores.js (off/shadow/on dispatch + logShadow +
// Promise.all comparator) and lib/identity.js (Supabase-first / Sheets-fallback-
// on-ERROR for the `on` path). Default flag `off` ⇒ Sheets only, byte-identical to
// today; deploying is inert until READ_SUPABASE_CHECKINS is set.
//
// NOT flag-gated (on purpose): lib/generateReport.fetchCheckinHistory. It is a
// synchronous read-after-own-write in the submitUpdateForm write path — a reconcile-
// lagged Supabase mirror would miss the just-appended row — so it stays on Sheets.

const ZONE = 'America/Los_Angeles'

// Supabase `instructor` enum → the display label the dev surfaces show. The Sheets
// path emits 'Ryan'/'Aaron' (the form-tab labels), so this MUST match those exactly
// for flag=off↔on parity. (`art` exists in the global enum but no art check-ins are
// stored, and neither dev surface has an art form tab; the `|| instructor` fallback
// keeps an unexpected value from rendering as `undefined`.)
const WHO = { ryan: 'Ryan', aaron: 'Aaron' }

// The two Master form-log tabs (A=Timestamp, B=Name). Order is load-bearing: the
// batchGet returns valueRanges in this order, so index i selects the `who` label —
// identical to the [sheetId] route's old inline CHECKIN_TABS / shared.CHECKIN_FORM_TABS.
const CHECKIN_TABS = [
  { tab: 'CheckinForm', who: 'Ryan' },
  { tab: 'A_CheckinForm', who: 'Aaron' },
]

// trim / lower / collapse-spaces — identical to shared.normName and the [sheetId]
// route's old local copy, so the name-join and the recency Map keys stay byte-for-byte
// the same under flag=off (and the roster consumer that joins by normName(name) is
// unaffected).
export const normName = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ')

// ── getCheckinTimeline ──────────────────────────────────────────────────────
// One student's check-in dates across BOTH form tabs → [{date:'yyyy-MM-dd',
// who:'Ryan'|'Aaron'}] sorted asc. The dev scoring page overlays these as ticks.

// Sheets path: ONE Master batchGet (CheckinForm!A:B + A_CheckinForm!A:B,
// UNFORMATTED_VALUE), joined to the student by normalized form-name — the exact
// logic the [sheetId] route ran inline, so flag=off is unchanged.
async function getCheckinTimelineFromSheets(sheets, studentName) {
  const res = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: process.env.MASTER_SHEET_ID,
    ranges: CHECKIN_TABS.map((t) => `${t.tab}!A:B`),
    valueRenderOption: 'UNFORMATTED_VALUE',
  })
  const key = normName(studentName)
  const out = []
  ;(res.data.valueRanges || []).forEach((vr, i) => {
    for (const r of (vr.values || []).slice(1)) {
      if (normName(r?.[1]) !== key) continue
      const date = cellToISODate(r?.[0])
      if (date) out.push({ date, who: CHECKIN_TABS[i].who })
    }
  })
  out.sort((a, b) => (a.date < b.date ? -1 : 1))
  return out
}

// Supabase path: the `checkins` mirror, keyed by student_sheet_id (the backfill
// already resolved aliased/whitespace names → so this is strictly MORE correct than
// the Sheets name-join; expect known name-join diffs in shadow). submitted_at is a
// UTC instant; the timeline renders an LA calendar date, so reconstruct via
// utc→LA→toISODate to match what cellToISODate produces from the Sheets serial.
async function getCheckinTimelineFromSupabase(studentSheetId) {
  if (!studentSheetId) return []
  const sb = getSupabaseClient()
  const { data, error } = await sb
    .from('checkins')
    .select('submitted_at, instructor')
    .eq('student_sheet_id', studentSheetId)
  // THROW (not return []) on a read error so the `on` path can distinguish a
  // Supabase blip (→ fall back to Sheets) from a clean "no check-ins" miss.
  if (error) throw new Error(`getCheckinTimeline failed: ${error.message}`)
  const out = (data || [])
    .map((row) => {
      const dt = DateTime.fromISO(String(row.submitted_at || ''), { zone: 'utc' }).setZone(ZONE)
      if (!dt.isValid) return null
      return { date: dt.toISODate(), who: WHO[row.instructor] || row.instructor }
    })
    .filter(Boolean)
    .sort((a, b) => (a.date < b.date ? -1 : 1))
  return out
}

// shadow comparator: diff the two {date,who} timelines as sets of `date|who` keys
// (date order within a single day is insertion-defined and not meaningful, so a
// set compare avoids false positives). Empty ⇒ match.
function diffCheckinTimeline(sheet, supa) {
  const diffs = []
  const ka = (sheet || []).map((c) => `${c.date}|${c.who}`).sort()
  const kb = (supa || []).map((c) => `${c.date}|${c.who}`).sort()
  if (ka.length !== kb.length) diffs.push(`len ${ka.length}≠${kb.length}`)
  const setA = new Set(ka)
  const setB = new Set(kb)
  for (const k of ka) if (!setB.has(k)) diffs.push(`sheets-only ${k}`)
  for (const k of kb) if (!setA.has(k)) diffs.push(`supa-only ${k}`)
  return diffs
}

// Reads from Sheets, Supabase, or both per the `checkins` read flag (lib/readFlags.js).
// Default off ⇒ Sheets, unchanged. shadow reads both, logs diffs, returns Sheets.
// on ⇒ Supabase-first, Sheets-fallback-on-ERROR.
export async function getCheckinTimeline(sheets, studentSheetId, studentName) {
  const mode = readMode('checkins')
  if (mode === 'on') {
    try {
      return await getCheckinTimelineFromSupabase(studentSheetId)
    } catch (e) {
      console.warn(`[checkins:supabase] getCheckinTimeline fell back to Sheets: ${e?.message}`)
      return getCheckinTimelineFromSheets(sheets, studentName)
    }
  }
  if (mode === 'shadow') {
    const [sheetRes, supaRes] = await Promise.all([
      getCheckinTimelineFromSheets(sheets, studentName),
      getCheckinTimelineFromSupabase(studentSheetId).catch((e) => {
        console.warn(`[shadow:checkins] ${studentSheetId} timeline supabase read threw: ${e?.message}`)
        return null
      }),
    ])
    logShadow('checkins', `timeline:${studentSheetId}`, diffCheckinTimeline(sheetRes, supaRes))
    return sheetRes // shadow ALWAYS returns the authoritative Sheets answer
  }
  return getCheckinTimelineFromSheets(sheets, studentName)
}

// ── readLatestCheckins ──────────────────────────────────────────────────────
// Map<normName(student) → latest check-in ISO date> across BOTH form tabs. The
// Students-tab compliance pill joins this by normName(roster name); the map shape
// is kept name-keyed so the roster consumer needs no change regardless of source.

// Sheets path: ONE Master batchGet (the exact logic shared.readLatestCheckins ran),
// keeping the latest ISO per name. ISO yyyy-MM-dd strings compare lexically.
async function readLatestCheckinsFromSheets(sheets) {
  const res = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: process.env.MASTER_SHEET_ID,
    ranges: CHECKIN_TABS.map((t) => `${t.tab}!A:B`),
    valueRenderOption: 'UNFORMATTED_VALUE',
  })
  const byName = new Map()
  for (const vr of res.data.valueRanges || []) {
    for (const r of (vr.values || []).slice(1)) {
      const key = normName(r?.[1])
      if (!key) continue
      const iso = cellToISODate(r?.[0])
      if (!iso) continue
      const prev = byName.get(key)
      if (!prev || iso > prev) byName.set(key, iso)
    }
  }
  return byName
}

// Supabase path: the `checkins` mirror joined to `students(name)`, keyed by
// normName(students.name) — same name-keyed shape so the roster route is unchanged.
// submitted_at is a UTC instant → reconstruct the LA date (same as the timeline).
async function readLatestCheckinsFromSupabase() {
  const sb = getSupabaseClient()
  const { data, error } = await sb.from('checkins').select('submitted_at, students(name)')
  if (error) throw new Error(`readLatestCheckins failed: ${error.message}`) // see getCheckinTimelineFromSupabase
  const byName = new Map()
  for (const row of data || []) {
    const key = normName(row.students?.name)
    if (!key) continue
    const dt = DateTime.fromISO(String(row.submitted_at || ''), { zone: 'utc' }).setZone(ZONE)
    if (!dt.isValid) continue
    const iso = dt.toISODate()
    const prev = byName.get(key)
    if (!prev || iso > prev) byName.set(key, iso)
  }
  return byName
}

// shadow comparator: diff the two name→latestISO maps key-by-key. Empty ⇒ match.
function diffLatestCheckins(a, b) {
  const diffs = []
  for (const [k, v] of a) {
    const w = b.get(k)
    if (w === undefined) diffs.push(`sheets-only ${k}=${v}`)
    else if (v !== w) diffs.push(`${k} ${v}≠${w}`)
  }
  for (const [k, v] of b) if (!a.has(k)) diffs.push(`supa-only ${k}=${v}`)
  return diffs
}

// Reads per the `checkins` flag (lib/readFlags.js). Default off ⇒ Sheets, unchanged.
// shadow reads both, logs diffs, returns Sheets. on ⇒ Supabase-first, Sheets-fallback-
// on-ERROR. Always returns Map<normName, latestISO> — the roster consumer's shape.
export async function readLatestCheckins(sheets) {
  const mode = readMode('checkins')
  if (mode === 'on') {
    try {
      return await readLatestCheckinsFromSupabase()
    } catch (e) {
      console.warn(`[checkins:supabase] readLatestCheckins fell back to Sheets: ${e?.message}`)
      return readLatestCheckinsFromSheets(sheets)
    }
  }
  if (mode === 'shadow') {
    const [sheetRes, supaRes] = await Promise.all([
      readLatestCheckinsFromSheets(sheets),
      readLatestCheckinsFromSupabase().catch((e) => {
        console.warn(`[shadow:checkins] readLatestCheckins supabase read threw: ${e?.message}`)
        return new Map()
      }),
    ])
    logShadow('checkins', 'readLatestCheckins', diffLatestCheckins(sheetRes, supaRes))
    return sheetRes // shadow ALWAYS returns the authoritative Sheets answer
  }
  return readLatestCheckinsFromSheets(sheets)
}
