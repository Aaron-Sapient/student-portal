-- AP score self-report (Check-Ins tab → "AP Scores" card). Idempotent — safe to re-run.
--
-- One-shot-per-calendar-year self-report: a student reports every AP exam they
-- took (or explicitly says "took the class, skipped the exam") in a single
-- submission, gated by report_year so the same student/year/exam can't dup on
-- a retry. Source of truth for the app; a best-effort mirror write also lands
-- in the student's own 📃 Student Info!B58:AB74 (see lib/apScores.js) so Ryan
-- and Aaron see it where they already work.
--
-- score is null when no_exam_taken = true (student took the class, not the test).
create table if not exists student_ap_scores (
  id              uuid        primary key default gen_random_uuid(),
  student_sheet_id text       not null references students(student_sheet_id) on delete cascade,
  exam_name       text        not null,
  score           smallint,
  no_exam_taken   boolean     not null default false,
  report_year     int         not null,
  created_at      timestamptz not null default now(),
  unique (student_sheet_id, report_year, exam_name),
  check ((no_exam_taken and score is null) or (not no_exam_taken and score between 1 and 5))
);
create index if not exists student_ap_scores_student_idx on student_ap_scores (student_sheet_id);
alter table student_ap_scores enable row level security;

-- Completion marker, decoupled from the per-exam rows above so a student with
-- genuinely zero AP exams this year can still complete the check-in (the
-- "done for this year" gate checks THIS table, not whether any score rows
-- exist — an empty submission is a valid, real answer, not a no-op).
create table if not exists ap_score_reports (
  student_sheet_id text       not null references students(student_sheet_id) on delete cascade,
  report_year      int        not null,
  created_at       timestamptz not null default now(),
  primary key (student_sheet_id, report_year)
);
alter table ap_score_reports enable row level security;
