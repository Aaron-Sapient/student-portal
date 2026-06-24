-- students_hub_schema.sql — additive, READ-ONLY mirrors for the Students-tab hub.
--
-- One-way Sheets → Supabase, written ONLY by scripts/mirrorStudentHub.cjs (run by
-- the reconcile cron). The app NEVER writes these back to the Google Sheet.
--
-- GUARDRAIL (see the plan): the live student-facing "This week with <instructor>"
-- card reads the 📆 Meetings tab DIRECTLY from Sheets (/api/colleges →
-- parseMeetingsGrid), NOT this table — so this mirror cannot affect it. The
-- `meetings` table here is SEPARATE from the legacy, unconsumed `meetings_log`
-- (date/teacher/notes only); do not conflate them.
--
-- RLS on + no policies ⇒ only the service-role key can touch these (same lockdown
-- as the other student-hubs tables). Safe to run repeatedly (IF NOT EXISTS).

-- Per-student card fields the roster can't get from the Master tab alone.
create table if not exists student_profiles (
  student_sheet_id text primary key,
  major            text,                                   -- 🔎 Overview!C6 "Major/Path"
  updated_at       timestamptz not null default now()
);
alter table student_profiles enable row level security;

-- The full 📆 Meetings agenda grid, mirrored row-for-row. `seq` is the row's
-- ordinal in the sheet (stable upsert key — survives same-date meetings and lets
-- the reconcile prune trailing rows without an empty-table window).
create table if not exists meetings (
  id               uuid primary key default gen_random_uuid(),
  student_sheet_id text not null,
  seq              int  not null,
  meeting_date     date,
  teacher          text,
  project          text,
  agenda           text,
  homework         text,
  hw_status        text,
  pct              text,
  updated_at       timestamptz not null default now(),
  unique (student_sheet_id, seq)
);
create index if not exists meetings_student_idx on meetings (student_sheet_id);
alter table meetings enable row level security;
