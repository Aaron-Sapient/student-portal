import { createClient } from '@supabase/supabase-js'

// Server-only Supabase client for the student-hubs project, using the
// SERVICE-ROLE key (bypasses RLS). NEVER import this into a client component or
// expose the key to the browser — authorization for editable documents is
// enforced in the API routes (Clerk session → master-sheet resolution →
// readEditableSource ownership check), exactly like the existing files routes.
//
// The student-hubs project's publishable key is student-visible; this table
// (document_revisions) is locked down with RLS-and-no-policies so only the
// service role can touch it. See ~/.claude/secrets/supabase-admissions-partners.

let cached = null

export function getSupabaseClient() {
  if (cached) return cached
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error(
      'Supabase not configured: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY'
    )
  }
  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  return cached
}

export const DOCUMENT_REVISIONS_TABLE = 'document_revisions'

// Markdown word processor (the "get students off Google Docs" platform). Its own
// tables, separate from the HTML document_revisions stack. See supabase/writing_schema.sql.
export const MD_DOCUMENTS = 'md_documents'
export const MD_TABS = 'md_tabs'
export const MD_TAB_REVISIONS = 'md_tab_revisions'
export const STUDENT_COLLEGE_LISTS = 'student_college_lists'

// Senior essay-program roster (Class of 2027). Drives deterministic booking.
// See supabase/writing_schema.sql and lib/seniors.js.
export const SENIORS_TABLE = 'seniors'

// Students-tab hub mirrors (additive, read-only one-way from Sheets — populated
// by the reconcile cron; the app never writes them back to the Sheet). See
// supabase/students_hub_schema.sql.
//   student_profiles — per-student card fields (intended major from 🔎 Overview!C6).
//   meetings         — the full 📆 Meetings agenda grid (date/teacher/project/
//                      agenda/homework/hw_status/pct). NOTE: a SEPARATE, additive
//                      table from the unconsumed legacy `meetings_log`; do not
//                      conflate them. The live student "This week with …" card
//                      reads the SHEET, not this table — see the plan's Guardrail.
export const STUDENT_PROFILES = 'student_profiles'
export const MEETINGS_TABLE = 'meetings'

// Auditable senior booking ledger: each weekly check-in writes a GRANT (one
// week's worth of meetings, spendable across the current+next Saturday-week), and
// each booking writes a CONSUMPTION row linked to the grant + calendar event.
// Replaces stateless calendar-counting. See supabase/writing_schema.sql.
export const SENIOR_CHECKIN_GRANTS = 'senior_checkin_grants'
export const SENIOR_BOOKINGS = 'senior_bookings'

// One-off "extra meeting" grants for seniors — a SEPARATE, ADDITIVE track from the
// weekly cadence above. An admin grants one extra meeting (teacher + length + window);
// canBookOnDate authorizes it as a fallback AFTER the weekly grant, so it never touches
// the package's weekly tokens/cross-meeting math. See supabase/senior_oneoff_grants.sql.
export const SENIOR_ONEOFF_GRANTS = 'senior_oneoff_grants'

// Standing weekly "project meeting" track — solo-research / project meetings OUTSIDE
// the college-app work, for both seniors and non-seniors. A THIRD, fully-additive
// track: its own per-student entitlement (project_meeting_plans) + consumption ledger
// (project_meeting_bookings), deep-linked as ?m=project:<id> so a same-teacher booking
// never charges the essay grant. 1 booking per Saturday-week per plan; no check-in gate.
// See supabase/project_meetings.sql and lib/projectMeetings.js / projectMeetingsCore.js.
export const PROJECT_MEETING_PLANS = 'project_meeting_plans'
export const PROJECT_MEETING_BOOKINGS = 'project_meeting_bookings'

// SAT practice surface — public, no-auth /sat route. Roster + an expandable quiz
// registry (vocab now, grammar later) + saved attempts (one per student/quiz).
// See supabase/sat_schema.sql and lib/satQuiz.js.
export const SAT_STUDENTS = 'sat_students'
export const SAT_QUIZZES = 'sat_quizzes'
export const SAT_ATTEMPTS = 'sat_attempts'

// AP score self-report (Check-Ins tab). See supabase/ap_scores_schema.sql and
// lib/apScores.js. AP_SCORE_REPORTS is the "submitted this year" completion
// marker, decoupled from the per-exam rows in STUDENT_AP_SCORES.
export const STUDENT_AP_SCORES = 'student_ap_scores'
export const AP_SCORE_REPORTS = 'ap_score_reports'

// Group-project census (summer 2026) — student-submitted "report in" (project
// plan / team members / timeline / preferred time), one row per student
// (unique student_sheet_id, upserted). RAW INTAKE ONLY: fuzzy team/roster
// reconciliation runs offline in a one-shot Claude pass, not in the app. See
// supabase/project_reports_schema.sql and app/api/submitProjectReport/route.js.
export const PROJECT_REPORTS = 'project_reports'

// Parent check-in log (Bucket-A cutover mirror). One row per parent meeting
// request: best-effort dual-written by lib/parentCheckinCore.js at submit time
// and kept fresh by the reconcile cron (scripts/backfillParentCheckins.cjs). The
// natural key (student_sheet_id, parent_email, submitted_at) dedupes the two
// writers; student_sheet_id is a NOT NULL FK, so unmatched-parent submissions are
// skipped (documented residual). See _notes/cutover-execution-plan.md.
export const PARENT_CHECKINS = 'parent_checkins'

// Written reports log (Bucket-A cutover mirror). One row per generated report,
// keyed on sheet_row (the WrittenReports tab's 1-based row = the developer
// route's rowIndex) so the app dual-writes (lib/generateReport.js insert +
// developer/writtenReports PATCH/POST updates) and the reconcile backfill all
// converge. parent_notified (col H) is written only by the external
// parentNotifier Apps Script → reconcile is its sole freshness path. The
// read-flip is deferred (dev-only surface). See _notes/cutover-execution-plan.md.
export const WRITTEN_REPORTS = 'written_reports'

// Ryan monthly meeting-cap + meeting-pair-date mirror (Bucket-A cutover;
// compliance_cap domain). One row PER STUDENT (current-state snapshot, not an
// append log, keyed on student_sheet_id) — kept fresh by
// scripts/backfillCheckinSummary.cjs on the reconcile cron; admin/grantBooking's
// cap-bump best-effort dual-writes meetings_allowed so a just-granted one-off
// isn't immediately stale. No app reader exists yet — checkinCompliance and
// validateBooking's cap check stay on Sheets (read-flip deferred, matching the
// parent_checkins/written_reports precedent). See _notes/cutover-execution-plan.md.
export const MEETING_CAP_SUMMARY = 'meeting_cap_summary'

// Meeting booking-token gate (Bucket-A cutover; booking_tokens domain — the LAST
// and highest-risk, a real-time authorization gate). One row PER (student,
// instructor): Master cols AZ=ryan / BB=aaron / BD=art mirror into token_value
// TEXT (ART's value is an ISO instant stored verbatim — a timestamptz round-trip
// would mutate the string the Saturday-reset comparison depends on). Unique key
// (student_sheet_id, instructor); consumed = (token_value === 'no'). Best-effort
// dual-written by lib/bookingTokens.js at all 8 grant/consume/cancel sites and
// kept exactly in sync (upsert + prune cleared cells) by
// scripts/backfillBookingTokens.cjs --reconcile on the reconcile cron. SENIORS
// and project meetings are EXCLUDED (their own Supabase ledgers). No app reader
// exists yet — validateBooking stays on Sheets (read-flip deferred, matching the
// parent_checkins/written_reports/compliance_cap precedent). See
// _notes/cutover-execution-plan.md.
export const BOOKING_TOKENS = 'booking_tokens'
