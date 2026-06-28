import { DateTime } from 'luxon'
// Relative (not '@/') specifiers: lib/projects.js is dynamic-imported by the node
// scripts (mirrorComps / shadowCompareComps) where the build-time '@/' alias does
// not resolve — relative paths work in BOTH the Next bundle and plain node (same
// reasoning as lib/collegeList.js).
import { getSupabaseClient } from './supabase.js'
import { readMode, logShadow } from './readFlags.js'

const ZONE = 'America/Los_Angeles'
const PROJECTS_RANGE = "'🏆 Comps & Projects'!E:N"

// 🏆 Comps & Projects date cell (UNFORMATTED_VALUE: Sheets serial number or
// string) → LA calendar date, or null.
function toLADate(raw) {
  if (raw === null || raw === undefined || raw === '') return null
  if (typeof raw === 'number') {
    const utc = DateTime.fromMillis(Math.round((raw - 25569) * 86400 * 1000), { zone: 'utc' })
    if (!utc.isValid) return null
    return DateTime.fromObject({ year: utc.year, month: utc.month, day: utc.day }, { zone: ZONE })
  }
  const dt = DateTime.fromISO(String(raw), { zone: ZONE })
  return dt.isValid ? dt : null
}

// The portal's definition of an active project, shared by /api/home-data and
// /api/parent/home-data. A row from '🏆 Comps & Projects'!E:N is active iff
// BOTH hold (a 🟢 alone or a date range alone is not enough):
//   - Status (col K) is 🟢
//   - the date range is explicitly active: End (col G) is present and
//     today-or-later, and Start (col F), when present, is today-or-earlier
// The admin report (lib/generateReport.js) intentionally uses a looser,
// yearly notion and does not belong here.
export function activeProjectsFromRows(rows) {
  const today = DateTime.now().setZone(ZONE).startOf('day')
  return (rows || [])
    .slice(1) // header
    .filter((row) => {
      if (String(row[6] ?? '').trim() !== '🟢') return false
      const end = toLADate(row[2])
      if (!end || end.startOf('day') < today) return false
      const start = toLADate(row[1])
      return !start || start.startOf('day') <= today
    })
    .map((row) => ({
      name: row[0],
      endDate: row[2],
      progress: row[4],
      link: row[8],
      owner: row[9] || null, // col N: 'Ryan' | 'Aaron' | null — gates write-back
    }))
}

// ── Flag-aware reader (Sheets→Supabase read cutover, domain `comps`) ──────────
// All four read sites (home-data, parent/home-data, generateReport,
// submitUpdateForm) consume the RAW '🏆 Comps & Projects'!E:N rows array and index
// it by sheet-relative number (then .slice(1) off the header). So both readers must
// return the SAME array-of-arrays shape, NOT typed objects — getProjectRows is a
// drop-in for `(await …values.get(E:N)).data.values`. Default flag off ⇒ Sheets,
// byte-for-byte unchanged. Mirrors lib/scores.js / lib/identity.js.

// ── Sheets reader (the current, authoritative path) ──────────────────────────
// No try/catch: in `off` mode the three Promise.all consumers (home-data, parent,
// generateReport) currently let a read error reject, and submitUpdateForm wraps the
// call itself — preserve both behaviors exactly.
export async function getProjectRowsFromSheets(sheets, studentSheetId) {
  if (!studentSheetId) return []
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: studentSheetId,
    range: PROJECTS_RANGE,
    valueRenderOption: 'UNFORMATTED_VALUE',
  })
  return res.data.values || []
}

// ── Supabase reader (migration target — table `student_comps`) ───────────────
// Reconstructs the exact raw E:N rows array so every existing index-based parser
// works UNCHANGED: rows[0] is a placeholder header that consumers .slice(1) off,
// then one SPARSE data row per student_comps row ORDERED BY seq, with values placed
// at the precise indices consumers read. Index 5 (col J bar) is left empty — no
// consumer reads it. Dates come back from PG `date` as 'YYYY-MM-DD' (render-identical
// to the Sheets serial via parseSheetDate / new Date(ISO)); progress is a JS number
// (float8) or null; name/status/owner are stored VERBATIM (trailing space is the
// col-E write-back key, and status/owner are compared with strict === downstream).
export async function getProjectRowsFromSupabase(studentSheetId) {
  if (!studentSheetId) return []
  const sb = getSupabaseClient()
  const { data, error } = await sb
    .from('student_comps')
    .select('seq, name, start_date, end_date, deadline, progress, status, details, link, owner')
    .eq('student_sheet_id', studentSheetId)
    .order('seq', { ascending: true })
  // THROW (not return []) on a read error so the dispatcher's `on` path can fall
  // back to Sheets instead of silently presenting "no projects" as authoritative.
  if (error) throw new Error(`student_comps query failed: ${error.message}`)
  const rows = [[]] // placeholder header — every consumer .slice(1)'s it off
  for (const r of data || []) {
    const row = []
    row[0] = r.name // col E — VERBATIM (trailing space is the write-back / React key)
    row[1] = r.start_date // col F
    row[2] = r.end_date // col G ("End"/Target — the portal's "due")
    row[3] = r.deadline // col H
    row[4] = r.progress // col I — JS number (float8) or null
    // row[5] = col J bar — intentionally left empty (no consumer reads it)
    row[6] = r.status // col K — drives the active filter (strict === downstream)
    row[7] = r.details // col L
    row[8] = r.link // col M
    row[9] = r.owner ?? null // col N — gates write-back; null/'' both render falsy
    rows.push(row)
  }
  return rows
}

// shadow comparator: diff the surface consumers actually render — the
// activeProjectsFromRows output per project, keyed by name. endDate is normalized
// through toLADate (serial vs ISO differ by representation only); progress compares
// as a number (non-numbers ⇒ "no progress", excluded from the bar either way).
function diffProjects(sheetRows, supaRows) {
  const diffs = []
  const norm = (p) => ({
    owner: p.owner ?? null,
    progress: typeof p.progress === 'number' ? p.progress : null,
    end: toLADate(p.endDate)?.toISODate() ?? null,
  })
  const mapA = new Map(activeProjectsFromRows(sheetRows).map((p) => [String(p.name ?? ''), norm(p)]))
  const mapB = new Map(activeProjectsFromRows(supaRows).map((p) => [String(p.name ?? ''), norm(p)]))
  for (const k of mapA.keys()) if (!mapB.has(k)) diffs.push(`supa missing "${k}"`)
  for (const k of mapB.keys()) if (!mapA.has(k)) diffs.push(`supa extra "${k}"`)
  for (const [k, a] of mapA) {
    const b = mapB.get(k)
    if (!b) continue
    if (a.owner !== b.owner) diffs.push(`owner@"${k}" ${a.owner}≠${b.owner}`)
    if (a.progress !== b.progress) diffs.push(`progress@"${k}" ${a.progress}≠${b.progress}`)
    if (a.end !== b.end) diffs.push(`end@"${k}" ${a.end}≠${b.end}`)
  }
  return diffs
}

// Raw E:N project rows for a student per the `comps` read flag (lib/readFlags.js).
// Default off ⇒ Sheets, unchanged. shadow reads both, logs diffs, returns Sheets.
// on ⇒ Supabase, with Sheets-fallback-on-ERROR (mirrors lib/identity.js): a
// transient Supabase failure degrades to the proven Sheets path rather than 500-ing
// the home page or rendering "no projects" as fact. A clean empty result is
// authoritative (the mirror reconciles ≤10 min).
export async function getProjectRows(sheets, studentSheetId) {
  const mode = readMode('comps')
  if (mode === 'on') {
    try {
      return await getProjectRowsFromSupabase(studentSheetId)
    } catch (e) {
      console.warn(`[comps:supabase] getProjectRows fell back to Sheets: ${e?.message}`)
      return getProjectRowsFromSheets(sheets, studentSheetId)
    }
  }
  if (mode === 'shadow') {
    const [sheetRows, supaRows] = await Promise.all([
      getProjectRowsFromSheets(sheets, studentSheetId),
      getProjectRowsFromSupabase(studentSheetId).catch((e) => {
        console.warn(`[shadow:comps] ${studentSheetId} supabase read threw: ${e?.message}`)
        return [[]]
      }),
    ])
    logShadow('comps', studentSheetId, diffProjects(sheetRows, supaRows))
    return sheetRows // shadow ALWAYS returns the authoritative Sheets answer
  }
  return getProjectRowsFromSheets(sheets, studentSheetId)
}
