import { DateTime } from 'luxon'
import { getSupabaseClient } from '@/lib/supabase'
import { readMode, logShadow } from '@/lib/readFlags'

const ZONE = 'America/Los_Angeles'
const SCORES_TAB = '📊 Scores'

// How old the newest row can be before we treat the scores as stale. The NAS
// cron refreshes weekly (staggered); 10 days gives one missed run of grace.
const STALE_DAYS = 10
// Coach notes ride along in the same row but expire faster — a two-week-old
// "nice work this week" reads wrong. (Mirrors the Coach module's expiry idea.)
const COACH_NOTE_DAYS = 7

// ── Display curve ─────────────────────────────────────────────────────────
// The sheet stores the model's RAW scores — the rubric's natural linear scale,
// bell-curved around ~50, which is also the space the ±3/week swing cap lives
// in. Students read 1–100 as academic grades, so every surface presents a
// CURVED score instead: a perfectly average raw 50 shows as 80 (grade-inflation
// reality — raised from 70 on 2026-06-12), and movement gets RPG-style harder
// the farther a score sits from that pivot (tanh tails in both directions —
// each extra display point costs more raw points).
// Recalibrating = tuning these three constants; history re-renders instantly.
// The two halves are deliberately different shapes (Aaron-calibrated against
// the 2026-06-10 sample): slipping below average registers quickly and then
// saturates (tanh), but climbing above 80 is a slow cubic grind — the model
// already hands out raw 70s/80s to merely-good students, so the display must
// not stretch them further. 90+ display = raw 90+ = genuinely elite.
const RAW_CENTER = 50 // the model's "perfectly average" raw score
export const PIVOT = 80 // what that average student sees
const CENTER_SLOPE = 1.2 // below-pivot: display points per raw point at the pivot
const UP_GAMMA = 3 // above-pivot exponent (higher = flatter just above 80)

// ── Grade dumbbell ─────────────────────────────────────────────────────────
// A gentle EQ-style shelf on top of the raw→display curve, keyed to grade
// level: the rubric naturally under-scores young students (years of
// engagement, AP load) and we want seniors walking into application season
// reading strong, so 9th-and-below and 12th get a small lift while 10th/11th
// sit exactly on the base curve. The lift is flat up to the pivot and fades
// linearly to zero at 100, so it can never push past the ceiling and 90+
// stays elite. Display-only, like the rest of the curve — raw sheet values
// are untouched and history re-renders instantly when these are tuned.
const gradeLift = (grade) => {
  if (grade == null) return 0
  if (grade <= 9) return 4
  if (grade >= 12) return 3
  return 0
}

// Master-roster Class column ("'27", "'30"…) → current grade level, flipping
// at June 1 so summer treats everyone as their rising grade (class of '27 is
// 12th from June 2026). "NC", blanks, and already-graduated classes → null.
export function gradeFromClass(classStr) {
  const m = String(classStr ?? '').match(/(\d{2})\s*$/)
  if (!m) return null
  const gradYear = 2000 + Number(m[1])
  const now = DateTime.now().setZone(ZONE)
  const seniorClassYear = now.month >= 6 ? now.year + 1 : now.year
  const grade = 12 - (gradYear - seniorClassYear)
  return grade >= 1 && grade <= 12 ? grade : null
}

// Reference (10th/11th, no lift): raw 0→29 · 20→46 · 30→57 · 40→68 · 47→76 ·
//            50→80 · 60→80 · 71→81 · 80→84 · 85→87 · 90→90 · 95→95 · 100→100
export function curveScore(raw, grade) {
  if (raw == null) return null
  let d
  if (raw >= RAW_CENTER) {
    const x = (raw - RAW_CENTER) / (100 - RAW_CENTER)
    d = PIVOT + (100 - PIVOT) * Math.pow(x, UP_GAMMA)
  } else {
    const t = Math.tanh(((RAW_CENTER - raw) * CENTER_SLOPE) / PIVOT)
    d = PIVOT - PIVOT * t
  }
  const lift = gradeLift(grade)
  if (lift) d += lift * Math.min(1, (100 - d) / (100 - PIVOT))
  return Math.round(d)
}

// Explicit null/undefined ⇒ null (a v1 row's absent Leadership, or a Supabase
// NULL column) — must stay null, never become a curved 0. An empty STRING from a
// sheet cell still falls through to 0, exactly as the original Sheets path did, so
// no displayed value changes.
const num = (v) => {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null
}

// A normalized raw record { date(ISO), academic, ec, leadership, overall, insight,
// coachNote, model } (raw scores already split per field) → the curved display
// entry. SHARED by the Sheets parser and the Supabase reader so both produce
// byte-identical output — the read cutover can't change a single displayed number.
function curveEntry(rec, grade) {
  const raw = {
    academic: num(rec.academic),
    ec: num(rec.ec),
    leadership: num(rec.leadership),
    overall: num(rec.overall),
  }
  return {
    date: rec.date,
    academic: curveScore(raw.academic, grade),
    ec: curveScore(raw.ec, grade),
    leadership: curveScore(raw.leadership, grade),
    overall: curveScore(raw.overall, grade),
    raw,
    insight: (rec.insight || '').trim() || null,
    coachNote: (rec.coachNote || '').trim() || null,
    model: (rec.model || '').trim() || null,
  }
}

// Rows are written by scripts/nas/scoreStudents.cjs as (rubric v2):
//   Date (ISO) | Academic | EC | Leadership | Overall | Insight | CoachNote | RubricVer | Model
// v1 rows (no Leadership column) are detected by 'v1' in the old RubricVer slot.
// Scores come back curved; the raw sheet values ride along under `raw` so the
// developer pane can show both while the calibration is tuned.
function parseRow(r, grade) {
  const date = DateTime.fromISO(String(r[0] || ''), { zone: ZONE })
  if (!date.isValid) return null
  const isV1 = r[6] === 'v1'
  return curveEntry(
    {
      date: date.toISODate(),
      academic: r[1],
      ec: r[2],
      leadership: isV1 ? null : r[3],
      overall: isV1 ? r[3] : r[4],
      insight: isV1 ? r[4] : r[5],
      coachNote: isV1 ? r[5] : r[6],
      model: isV1 ? r[7] : r[8],
    },
    grade
  )
}

// history (asc by date) → the { latest, prev, history(-16), stale } payload. Shared
// by both readers so the assembled shape is identical regardless of source.
function assembleScores(history) {
  if (history.length === 0) return null
  const latest = history[history.length - 1]
  const prev = history[history.length - 2] || null
  const stale =
    DateTime.fromISO(latest.date, { zone: ZONE }) <
    DateTime.now().setZone(ZONE).minus({ days: STALE_DAYS })
  return {
    latest,
    prev,
    // Full per-row scores so the UI can chart per-check-in deltas, not just the
    // overall trend.
    history: history
      .slice(-16)
      .map(({ date, academic, ec, leadership, overall }) => ({
        date,
        academic,
        ec,
        leadership,
        overall,
      })),
    stale,
  }
}

// ── Sheets reader (the current, authoritative path) ────────────────────────
async function getStudentScoresFromSheets(sheets, studentSheetId, grade) {
  if (!studentSheetId) return null
  let res
  try {
    res = await sheets.spreadsheets.values.get({
      spreadsheetId: studentSheetId,
      range: `'${SCORES_TAB}'!A2:I400`,
    })
  } catch {
    return null // tab not created yet → no scores
  }
  const history = (res.data.values || [])
    .map((r) => parseRow(r, grade))
    .filter(Boolean)
    .sort((a, b) => (a.date < b.date ? -1 : 1))
  return assembleScores(history)
}

// ── Supabase reader (migration target — table `scores`, RAW values stored) ──
// Curving + assembly are the SAME shared helpers the Sheets path uses, so output
// is identical by construction. v1/v2 column-shift was normalized into discrete
// columns at backfill, so there's no 'v1' detection here.
async function getStudentScoresFromSupabase(studentSheetId, grade) {
  if (!studentSheetId) return null
  const sb = getSupabaseClient()
  const { data, error } = await sb
    .from('scores')
    .select('scored_date, academic, ec, leadership, overall, insight, coach_note, model')
    .eq('student_sheet_id', studentSheetId)
    .order('scored_date', { ascending: true })
  if (error) {
    console.warn(`[scores:supabase] ${studentSheetId} query failed: ${error.message}`)
    return null
  }
  const history = (data || [])
    .map((row) => {
      const date = DateTime.fromISO(String(row.scored_date || ''), { zone: ZONE })
      if (!date.isValid) return null
      return curveEntry(
        {
          date: date.toISODate(),
          academic: row.academic,
          ec: row.ec,
          leadership: row.leadership,
          overall: row.overall,
          insight: row.insight,
          coachNote: row.coach_note,
          model: row.model,
        },
        grade
      )
    })
    .filter(Boolean)
    .sort((a, b) => (a.date < b.date ? -1 : 1))
  return assembleScores(history)
}

// shadow-mode comparator: returns human-readable diff strings (empty ⇒ match).
// Compares the displayed surface — latest curved fields + history depth + stale.
function diffScores(sheet, supa) {
  const diffs = []
  if (!sheet && !supa) return diffs
  if (!sheet || !supa) {
    diffs.push(`presence sheets=${sheet ? 'y' : 'n'} supa=${supa ? 'y' : 'n'}`)
    return diffs
  }
  for (const k of ['date', 'academic', 'ec', 'leadership', 'overall']) {
    const a = sheet.latest?.[k]
    const b = supa.latest?.[k]
    if (String(a) !== String(b)) diffs.push(`latest.${k} ${a}≠${b}`)
  }
  if (sheet.history.length !== supa.history.length) {
    diffs.push(`history.len ${sheet.history.length}≠${supa.history.length}`)
  }
  if (sheet.stale !== supa.stale) diffs.push(`stale ${sheet.stale}≠${supa.stale}`)
  return diffs
}

// Latest scores + trend history for a student, or null when the tab doesn't
// exist / has no rows. Fails closed like the Coach module: a `stale: true`
// result tells the UI to render the hollow "updating" state, never old numbers
// presented as fresh.
// `grade` (from gradeFromClass) applies the grade dumbbell; omitted → base curve.
//
// Reads from Sheets, Supabase, or both per the `scores` read flag (see
// lib/readFlags.js). Default `off` ⇒ Sheets, unchanged. `shadow` reads both, logs
// diffs, and returns the Sheets answer. `on` reads Supabase only.
export async function getStudentScores(sheets, studentSheetId, grade) {
  const mode = readMode('scores')
  if (mode === 'on') return getStudentScoresFromSupabase(studentSheetId, grade)
  if (mode === 'shadow') {
    const [sheetResult, supaResult] = await Promise.all([
      getStudentScoresFromSheets(sheets, studentSheetId, grade),
      getStudentScoresFromSupabase(studentSheetId, grade).catch((e) => {
        console.warn(`[shadow:scores] ${studentSheetId} supabase read threw: ${e?.message}`)
        return null
      }),
    ])
    logShadow('scores', studentSheetId, diffScores(sheetResult, supaResult))
    return sheetResult // shadow ALWAYS returns the authoritative Sheets answer
  }
  return getStudentScoresFromSheets(sheets, studentSheetId, grade)
}

// The production Claude Coach note: the latest Scores row's CoachNote, expiring
// after a week. Returns the same shape the hand-seeded map produces.
export async function getSheetCoachNote(sheets, studentSheetId) {
  const scores = await getStudentScores(sheets, studentSheetId)
  const latest = scores?.latest
  if (!latest?.coachNote) return null
  const generated = DateTime.fromISO(latest.date, { zone: ZONE })
  if (generated < DateTime.now().setZone(ZONE).minus({ days: COACH_NOTE_DAYS })) return null
  return {
    author: 'Claude Coach',
    message: latest.coachNote,
    generatedAt: generated.toISO(),
  }
}
