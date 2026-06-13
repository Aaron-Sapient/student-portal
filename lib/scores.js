import { DateTime } from 'luxon'

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

// Rows are written by scripts/nas/scoreStudents.cjs as (rubric v2):
//   Date (ISO) | Academic | EC | Leadership | Overall | Insight | CoachNote | RubricVer | Model
// v1 rows (no Leadership column) are detected by 'v1' in the old RubricVer slot.
// Scores come back curved; the raw sheet values ride along under `raw` so the
// developer pane can show both while the calibration is tuned.
function parseRow(r, grade) {
  const num = (v) => {
    const n = Number(v)
    return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null
  }
  const date = DateTime.fromISO(String(r[0] || ''), { zone: ZONE })
  if (!date.isValid) return null
  const isV1 = r[6] === 'v1'
  const raw = {
    academic: num(r[1]),
    ec: num(r[2]),
    leadership: isV1 ? null : num(r[3]),
    overall: isV1 ? num(r[3]) : num(r[4]),
  }
  return {
    date: date.toISODate(),
    academic: curveScore(raw.academic, grade),
    ec: curveScore(raw.ec, grade),
    leadership: curveScore(raw.leadership, grade),
    overall: curveScore(raw.overall, grade),
    raw,
    insight: ((isV1 ? r[4] : r[5]) || '').trim() || null,
    coachNote: ((isV1 ? r[5] : r[6]) || '').trim() || null,
    model: ((isV1 ? r[7] : r[8]) || '').trim() || null,
  }
}

// Latest scores + trend history for a student, or null when the tab doesn't
// exist / has no rows. Fails closed like the Coach module: a `stale: true`
// result tells the UI to render the hollow "updating" state, never old numbers
// presented as fresh.
// `grade` (from gradeFromClass) applies the grade dumbbell; omitted → base curve.
export async function getStudentScores(sheets, studentSheetId, grade) {
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
