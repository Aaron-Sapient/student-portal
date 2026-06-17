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

// Senior essay-program roster (Class of 2027). Drives deterministic, token-free
// booking. See supabase/writing_schema.sql and lib/seniors.js.
export const SENIORS_TABLE = 'seniors'
