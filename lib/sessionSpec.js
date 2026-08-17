// The ONE definition of what a "weekly session" (a project_meeting_plans row) may be:
// which teachers, which lengths, what a label may say — plus the parser for the
// compact spec string the CLI and docs use ("aaron/30/EAP English").
//
// Pure and dependency-free ON PURPOSE: imported by a client component (the developer
// panel's form), an API route (admin/grantProjectMeeting), and a plain-Node script
// (scripts/sessions.mjs). Before this file each of those carried its own copy of the
// rules and they drifted — the panel offered 15/30 while 20/45/60-min plans were being
// hand-inserted around it with no granted_by. Change a rule here and every entry point
// changes together. The DB itself only constrains teacher ∈ (aaron, ryan).

// Portal-bookable teachers. A plan's teacher must have a calendar + hours in
// lib/instructors.js — that is what "bookable" means. Anyone else (e.g. an outside
// tutor) is off-portal: no plan row, name them in the plan `note` if useful.
export const SESSION_TEACHERS = ['aaron', 'ryan'];

// Every length seen in a real package (audit 2026-08-17: 15, 20, 30, 45, 60). Slot
// generation steps by the plan's own length and validateInstructorHours requires the
// meeting to END inside the teacher's window, so any of these tiles cleanly.
export const SESSION_LENGTHS = [15, 20, 30, 45, 60];

// A plan's label reaches the calendar TITLE (blank-agenda default) — and two consumers
// drop any event whose title contains "parent": the developer all-meetings panel
// (belongsToStudent) and the meeting-tracker Apps Script behind meeting_cap_summary.
// A plan labelled "Parent Check-in" would make every one of its bookings silently
// vanish from both, so the label refuses the word. Word-bounded like
// lib/calendarTitles.js so "apparent"/"transparent" still pass.
const PARENT_WORD = /\bparents?\b/i;
export const SESSION_LABEL_MAX = 40; // it's a card title and a calendar-title suffix

// Accepts a slug OR a display name, case-insensitively → canonical slug, or null.
export function normalizeTeacher(input) {
  const s = String(input || '').trim().toLowerCase();
  if (!s) return null;
  if (SESSION_TEACHERS.includes(s)) return s;
  if (s === 'ryan choi' || s === 'ryan-choi' || s === 'ryanchoi') return 'ryan';
  return null;
}

// "30" | "30min" | "30m" | "30 minutes" → 30 (or NaN).
export function normalizeMinutes(input) {
  const m = String(input ?? '').trim().match(/^(\d{1,3})\s*(?:m|min|mins|minute|minutes)?$/i);
  return m ? parseInt(m[1], 10) : NaN;
}

// Validate ONE session. Returns { ok: true, value: { teacher, minutes, label } } or
// { ok: false, error }. The same verdict everywhere: route → 400, CLI → refuse, form → disabled.
export function validateSession({ teacher, minutes, label }) {
  const slug = normalizeTeacher(teacher);
  if (!slug) return { ok: false, error: `Teacher must be one of ${SESSION_TEACHERS.join(', ')} (got “${teacher}”).` };
  const mins = normalizeMinutes(minutes);
  if (!SESSION_LENGTHS.includes(mins)) {
    return { ok: false, error: `Length must be one of ${SESSION_LENGTHS.join('/')} minutes (got “${minutes}”).` };
  }
  const clean = String(label || '').replace(/\s+/g, ' ').trim();
  if (!clean) return { ok: false, error: 'Label is required — it is what the student sees on the card and in the calendar title (e.g. “EAP English”).' };
  if (clean.length > SESSION_LABEL_MAX) return { ok: false, error: `Label is too long (${clean.length} > ${SESSION_LABEL_MAX} chars).` };
  if (PARENT_WORD.test(clean)) {
    return {
      ok: false,
      error: 'Label can’t contain “parent” — meetings whose title says parent are filtered out of meeting reports. Try “Family Planning” or similar.',
    };
  }
  return { ok: true, value: { teacher: slug, minutes: mins, label: clean } };
}

// The compact spec: "<teacher>/<minutes>/<label>", e.g. "aaron/30/EAP English",
// "ryan/45min/ACT Reading". The label may itself contain "/" — only the first two
// separators split. Returns validateSession's shape.
export function parseSessionSpec(spec) {
  const raw = String(spec || '').trim();
  const m = raw.match(/^([^/]+)\/([^/]+)\/(.+)$/);
  if (!m) return { ok: false, error: `Can’t parse “${raw}” — expected teacher/minutes/label, e.g. aaron/30/EAP English.` };
  return validateSession({ teacher: m[1], minutes: m[2], label: m[3] });
}

// Two sessions are "the same session" when teacher + length + label match (label
// case-insensitive). This is the identity the CLI reconciles on and the duplicate
// guard the admin route applies — a second identical ACTIVE plan is a silent 2/week.
export function sameSession(a, b) {
  return (
    String(a.teacher).toLowerCase() === String(b.teacher).toLowerCase() &&
    Number(a.minutes) === Number(b.minutes) &&
    String(a.label || '').trim().toLowerCase() === String(b.label || '').trim().toLowerCase()
  );
}

export function formatSession(s) {
  return `${s.teacher}/${s.minutes}/${s.label}`;
}
