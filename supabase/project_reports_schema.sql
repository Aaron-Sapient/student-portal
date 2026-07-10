-- Group-project census (summer 2026). One student-submitted "report in" per
-- student: their project plan / confirmed team members / timeline & deadlines /
-- preferred meeting time. This is RAW INTAKE ONLY — the fuzzy team-name/roster
-- reconciliation (e.g. "Corruption Project" == "Anti-Corruption Project") happens
-- in a separate one-shot Claude pass over these rows, NOT in the app. Booking
-- tokens are granted downstream from the reconciled result, not on submit.
-- See app/api/submitProjectReport/route.js and app/(portal)/project-report/.
--
-- `response` captures the full census, not just full reports:
--   'finalized'     — a complete report (project_* fields populated).
--   'not_finalized' — on a project, roster not set → told to email Ryan directly.
--   'no_project'    — not on a group project this summer.
--
-- Apply via the session pooler (see project CLAUDE.md, SAT section):
--   psql "host=aws-1-us-east-2.pooler.supabase.com port=5432 \
--         user=postgres.zzorytmjnrwckaqryudv dbname=postgres" -f project_reports_schema.sql

create table if not exists project_reports (
  id               uuid primary key default gen_random_uuid(),
  student_sheet_id text not null unique,
  student_email    text,
  student_name     text,
  student_class    text,
  response         text not null
                   check (response in ('finalized', 'not_finalized', 'no_project')),
  project_name     text,
  project_plan     text,
  team_members     text,
  timeline         text,
  preferred_time   text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- Same posture as the other student-hubs tables: RLS on, NO policies, so only the
-- service-role key (used server-side by the API routes, which bypasses RLS) can
-- read/write. The student-visible publishable key sees nothing here.
alter table project_reports enable row level security;
