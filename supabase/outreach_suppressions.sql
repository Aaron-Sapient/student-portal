-- Per-student suppression for the autonomous meeting nudge.
--
-- Silences the essay nudge for a student during a known no-meeting stretch
-- (vacation, between program phases, a paused enrollment) so a legitimate quiet
-- week never produces a parent-facing false alarm. Suppressed IFF a row exists AND
-- (until IS NULL  ->  indefinite, OR  until >= current_date  ->  still within it).
--
-- A standalone table (not a `seniors` column) on purpose: it stays independent of
-- the roster and is set/cleared with a one-line SQL insert/delete. Service-role only.
create table if not exists outreach_suppressions (
  student_sheet_id text primary key,
  reason           text,
  until            date,           -- NULL = indefinite; else suppressed through this date (inclusive)
  created_by       text,
  created_at       timestamptz not null default now()
);

alter table outreach_suppressions enable row level security;
-- No policies: service-role only.
