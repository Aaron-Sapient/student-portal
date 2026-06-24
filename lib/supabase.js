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

// SAT practice surface — public, no-auth /sat route. Roster + an expandable quiz
// registry (vocab now, grammar later) + saved attempts (one per student/quiz).
// See supabase/sat_schema.sql and lib/satQuiz.js.
export const SAT_STUDENTS = 'sat_students'
export const SAT_QUIZZES = 'sat_quizzes'
export const SAT_ATTEMPTS = 'sat_attempts'
