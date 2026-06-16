// Data-sufficiency gate for scoring + the score dashboard.
//
// CommonJS (module.exports) ON PURPOSE: this is shared by BOTH the Next.js
// routes (which import it with webpack/turbopack CJS interop) AND the raw-Node
// scoring cron (scripts/nas/scoreStudents.cjs, which require()s it). Keeping it
// dependency-free + timezone-free — callers pass `now` as an LA-pinned
// { year, month } object — means there's no Luxon/Date logic to diverge here.
//
// "Enough data to evaluate" = the student has a recorded grade for the current
// OR the previous semester (1-month grace at each semester start). A student
// below that bar gets a grayed-out score dashboard and is skipped by the cron.

// ── Transcript geometry ─────────────────────────────────────────────────────
// The 🎓 Transcript tab is a 4-quadrant grid (mirrors getGradeRanges in
// app/api/getUpdateFormData/route.js). For a (gradeYear, semester) the recorded
// grade lives in one column over a fixed row band:
//   9th  → S1 col H, S2 col K, rows 6–15
//   10th → S1 col H, S2 col K, rows 24–33
//   11th → S1 col S, S2 col V, rows 6–15
//   12th → S1 col S, S2 col V, rows 24–33
// Column letters as 0-based indices: H=7, K=10, S=18, V=21.
const SLOT_GEOMETRY = {
  9:  { s1Col: 7,  s2Col: 10, rowStart: 6,  rowEnd: 15 },
  10: { s1Col: 7,  s2Col: 10, rowStart: 24, rowEnd: 33 },
  11: { s1Col: 18, s2Col: 21, rowStart: 6,  rowEnd: 15 },
  12: { s1Col: 18, s2Col: 21, rowStart: 24, rowEnd: 33 },
};

// A cell counts as a recorded grade if it looks like a letter grade (A–F, ±),
// a pass/credit marker, or a number/percent — guards against stray header text
// or a pre-filled class name with no grade beside it yet.
function looksLikeGrade(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return false;
  return /^[A-F][+-]?$/i.test(s) || /^(P|PASS|CR|NP|I|W)$/i.test(s) || /^\d{1,3}%?$/.test(s);
}

// Class string ("'28", "2028", "28") → graduation year (2028) or null.
function gradYearFromClass(classStr) {
  const m = String(classStr == null ? '' : classStr).match(/(\d{2})\s*$/);
  if (!m) return null;
  return 2000 + Number(m[1]);
}

// The grade level (9–12) the student is currently in (during the school year)
// or just finished (over the summer) — academic-calendar based, NOT the June
// rising-grade flip used for the display curve (lib/scores.gradeFromClass).
// nowLA = { year, month } in America/Los_Angeles, month 1–12.
function academicGrade(classStr, nowLA) {
  const gradYear = gradYearFromClass(classStr);
  if (gradYear == null) return null;
  const { year, month } = nowLA;
  // Fall (Sep–Dec) the student has rolled into the new grade; Jan–Aug they're
  // still in (or just finished) the grade that graduates `gradYear`.
  return month >= 9 ? 12 - gradYear + year + 1 : 12 - gradYear + year;
}

function slotHasGrade(transcript, grade, sem) {
  const geo = SLOT_GEOMETRY[grade];
  if (!geo) return false;
  const col = sem === 'S2' ? geo.s2Col : geo.s1Col;
  for (let row = geo.rowStart; row <= geo.rowEnd; row++) {
    if (looksLikeGrade(transcript?.[row - 1]?.[col])) return true;
  }
  return false;
}

// Does the student have recorded grades for a recent semester?
// transcript = 🎓 Transcript!A1:V40 values (2-D array, A1-origin).
// Returns { enough, reason, grade }.
function hasRecentGrades(transcript, classStr, nowLA) {
  const grade = academicGrade(classStr, nowLA);
  if (grade == null) return { enough: true, reason: 'unknown-class', grade: null };

  const { month } = nowLA;
  let current = null;
  let previous = null;
  if (month >= 9) {           // fall term — current grade's S1 is in progress
    current = { grade, sem: 'S1' };
    previous = { grade: grade - 1, sem: 'S2' };
  } else if (month <= 5) {    // spring term — current grade's S2 is in progress
    current = { grade, sem: 'S2' };
    previous = { grade, sem: 'S1' };
  } else {                    // summer — no current term; `grade` just finished
    current = null;
    previous = { grade, sem: 'S2' };
  }
  // Grace: first calendar month of a new term (Sep for S1, Jan for S2) — the
  // current slot is expected-empty, so its emptiness alone doesn't flag.
  const inGrace = month === 9 || month === 1;

  // Real high-school slots (grades 9–12) worth inspecting. "Previous" is the
  // SINGLE immediately-preceding semester, not "either semester of the prior
  // year" — over the summer, a rising 10th-grader needs grades for 9th-grade
  // S2 (the spring just finished); 9th-grade S1 alone is two semesters stale and
  // does NOT count (live example: Tarit Voni, S1-only freshman grades → gate).
  const candidates = [];
  if (current && current.grade >= 9 && current.grade <= 12) candidates.push(current);
  if (previous && previous.grade >= 9 && previous.grade <= 12) candidates.push(previous);

  if (candidates.some((s) => slotHasGrade(transcript, s.grade, s.sem))) {
    return { enough: true, reason: 'has-recent-grades', grade };
  }

  // No grades in any recent slot. Distinguish "too early to tell" from "data-poor".
  const expected = candidates.filter(
    (s) => !(inGrace && current && s.sem === current.sem && s.grade === current.grade)
  );
  if (expected.length === 0) {
    // Nothing was due yet: a brand-new student in the grace window, or a rising
    // 9th-grader over the summer (no completed HS semester exists on file).
    return { enough: true, reason: 'pre-enrollment-or-grace', grade };
  }
  return { enough: false, reason: 'no-recent-grades', grade };
}

// Range a caller should read to feed `transcript` above.
const TRANSCRIPT_GRADE_RANGE = "'🎓 Transcript'!A1:V40";

module.exports = {
  academicGrade,
  hasRecentGrades,
  looksLikeGrade,
  SLOT_GEOMETRY,
  TRANSCRIPT_GRADE_RANGE,
};
