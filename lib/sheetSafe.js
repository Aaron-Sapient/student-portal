// ============================================================================
// lib/sheetSafe.js — neutralize spreadsheet formula injection in untrusted text.
//
// THE BUG THIS CLOSES. Every write below goes to the Master Sheet with
// `valueInputOption: 'USER_ENTERED'`, which makes Sheets *parse* the string. A
// value beginning `=` becomes a live formula. `IMPORTXML` / `IMPORTDATA` /
// `IMPORTRANGE` fetch external URLs, so a formula planted by a student (the
// check-in concerns box) or by an anonymous internet POST (/api/parentCheckin,
// which is public by design) can exfiltrate neighbouring cells — student and
// parent emails, grades, the whole roster — the moment a human opens the tab.
// The model-authored fields are equally untrusted: a prompt injection that makes
// the evaluator emit a `reason` starting with `=` lands the formula for free.
//
// WHY GUARD RATHER THAN SWITCH TO 'RAW'. valueInputOption is per-REQUEST, not
// per-cell, and these rows mix untrusted text with values whose Sheets typing is
// load-bearing (timestamps, the WrittenReports col-G boolean that renders as a
// checkbox, numeric day counts). Flipping the whole call to RAW would silently
// change how those land. Prefixing an apostrophe neutralizes the formula parse
// and leaves every other cell's behavior byte-identical to today.
//
// LIFESPAN. This module is Sheets-specific and has no Postgres equivalent. When
// the Google Drive cutover lands, DELETE IT — do not port it. The authorization
// fix it sits beside (server-side identity resolution) is the one that carries
// over. See _notes/md-doc-metadata-braindump-and-security-audit-2026-08-22.md, S2.
// ============================================================================

// Google Sheets begins formula parsing on these leaders. `\s*` matters: the test
// must survive a leading space or tab, or " =IMPORTXML(…)" would walk straight
// past a check that only ever inspected character zero. (`@` is Excel/Lotus
// legacy rather than a Sheets leader — kept because over-inclusion here is free.)
//
// ⚠ UNVERIFIED, and deliberately routed around: the standard claim is that Sheets
// consumes the guard apostrophe rather than storing it, so the value reads back
// as typed. That round-trip is NOT tested here, so no value this guard touches may
// also be matched raw downstream — which is why the check-in routes pass
// studentName through UNGUARDED (it is server-resolved, not user input, and the
// CheckinForm name match is exact). Test before relying on the round-trip:
// write '=1+1 with USER_ENTERED, read back UNFORMATTED_VALUE, expect =1+1.
const FORMULA_LEADERS = /^\s*[=+\-@]/

// Wrap any value that a student, a parent, or a model authored. Non-strings
// (numbers, booleans, null) pass through untouched — they cannot carry a formula
// and their Sheets typing is the point.
export function sheetSafe(value) {
  if (typeof value !== 'string') return value
  return FORMULA_LEADERS.test(value) ? `'${value}` : value
}
