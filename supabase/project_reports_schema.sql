-- Group-project census (summer 2026). A student "reports in" on their group
-- project(s). A single student can be on MULTIPLE projects → ONE ROW PER
-- (student, project_index). This is RAW INTAKE ONLY — the fuzzy team-name/roster
-- reconciliation (e.g. "Corruption Project" == "Anti-Corruption Project") happens
-- in a separate one-shot Claude pass over these rows, NOT in the app. Booking
-- tokens are granted downstream from the reconciled result, not on submit.
-- See app/api/submitProjectReport/route.js and app/(portal)/project-report/.
--
-- `response` captures the full census per row:
--   'finalized'     — a complete report (project_* fields populated).
--   'not_finalized' — on a project, roster not set → told to email Ryan directly.
--   'no_project'    — not on any group project (a single marker row at index 0).
--
-- Idempotent: safe to re-apply. The ALTER block below migrates the original
-- single-row-per-student table (unique student_sheet_id) to the multi-project shape.
--
-- Apply via the session pooler (see project CLAUDE.md, SAT section):
--   psql "host=aws-1-us-east-2.pooler.supabase.com port=5432 \
--         user=postgres.zzorytmjnrwckaqryudv dbname=postgres" -f project_reports_schema.sql

create table if not exists project_reports (
  id               uuid primary key default gen_random_uuid(),
  student_sheet_id text not null,
  project_index    int not null default 0,
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

-- Migrate an existing (pre-multi-project) table + normalize the unique key.
alter table project_reports add column if not exists project_index int not null default 0;
alter table project_reports drop constraint if exists project_reports_student_sheet_id_key;
do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'project_reports_student_index_key'
  ) then
    alter table project_reports
      add constraint project_reports_student_index_key unique (student_sheet_id, project_index);
  end if;
end $$;

-- Same posture as the other student-hubs tables: RLS on, NO policies, so only the
-- service-role key (used server-side by the API routes, which bypasses RLS) can
-- read/write. The student-visible publishable key sees nothing here.
alter table project_reports enable row level security;
