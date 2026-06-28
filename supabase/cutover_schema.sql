-- Sheets→Supabase FULL read-cutover schema migration (2026-06-27)
-- Source of record: the consolidated synthesis plan (session 8bef413f).
-- Preconditions VERIFIED live before apply: instructor enum = {aaron,ryan};
-- set_updated_at() exists; 0 dups on (checkins natural key) and (transcript natural
-- key); 0 null/orphan meetings.student_sheet_id; new cols/tables absent.
--
-- Apply order:
--   1) PHASE 0 standalone (psql -f, NOT inside a tx — ALTER TYPE ADD VALUE rule)
--   2) PHASE 1 in one transaction
--   3) PHASE 2 per-domain, each AFTER that domain's backfill/normalization (see notes)
-- Decisions baked in (synthesis defaults): ART via enum; gender→students;
-- SAT/#APs as text; checkin_summary RENAMED → meeting_cap_summary; needs_checkin
-- + AY/BA → students; comps via student_comps + nullable project_id placeholder.

-- ============================================================================
-- PHASE 0 — ENUM (run standalone; commit before any 'art' row is written)
-- ============================================================================
ALTER TYPE instructor ADD VALUE IF NOT EXISTS 'art';   -- booking_tokens ART slot

-- ============================================================================
-- PHASE 1 — additive columns + new tables + verified-safe natural keys.
-- All nullable / new; FKs target the already-populated students table.
-- ============================================================================
BEGIN;

-- written_reports (A): sheet-position key + lossless instant + name parity
ALTER TABLE written_reports  ADD COLUMN IF NOT EXISTS sheet_row    integer;
ALTER TABLE written_reports  ADD COLUMN IF NOT EXISTS report_at    timestamptz;
ALTER TABLE written_reports  ADD COLUMN IF NOT EXISTS student_name text;

-- overview_profile (B): widen student_profiles + add students.gender
ALTER TABLE student_profiles ADD COLUMN IF NOT EXISTS display_name text;   -- Overview!B2 (UN-trimmed)
ALTER TABLE student_profiles ADD COLUMN IF NOT EXISTS current_year text;   -- Overview!C4 (= students.grade source)
ALTER TABLE student_profiles ADD COLUMN IF NOT EXISTS sat          text;   -- Overview!C17 (TEXT for byte fidelity)
ALTER TABLE student_profiles ADD COLUMN IF NOT EXISTS num_aps      text;   -- Overview!C18
ALTER TABLE students         ADD COLUMN IF NOT EXISTS gender       text;   -- Master col AX (idx 49)

-- compliance_cap (B): roster attributes checkinCompliance reads inline (GAP #3/#8)
ALTER TABLE students ADD COLUMN IF NOT EXISTS needs_checkin      boolean;     -- Master BE (idx 56)
ALTER TABLE students ADD COLUMN IF NOT EXISTS last_ryan_checkin  timestamptz; -- Master AY (idx 50)
ALTER TABLE students ADD COLUMN IF NOT EXISTS last_aaron_checkin timestamptz; -- Master BA (idx 52)

-- compliance_cap: the ✅ Check-Ins tab mirror (GAP #4). Named meeting_cap_summary
-- (NOT checkin_summary) to avoid confusion with the existing `checkins` form table.
CREATE TABLE IF NOT EXISTS meeting_cap_summary (
  student_sheet_id       text PRIMARY KEY REFERENCES students(student_sheet_id) ON DELETE CASCADE,
  student_name           text,           -- col A, audit only (NOT the join key)
  meetings_used          integer,        -- col H (NULL→reader treats as 0)
  meetings_allowed       integer,        -- col I (NULL = uncapped)
  last_ryan_meeting      timestamptz,    -- col J
  upcoming_ryan_meeting  timestamptz,    -- col K
  last_aaron_meeting     timestamptz,    -- col L
  upcoming_aaron_meeting timestamptz,    -- col M
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS meeting_cap_summary_student_idx ON meeting_cap_summary (student_sheet_id);
ALTER TABLE meeting_cap_summary ENABLE ROW LEVEL SECURITY;
DROP TRIGGER IF EXISTS meeting_cap_summary_set_updated ON meeting_cap_summary;
CREATE TRIGGER meeting_cap_summary_set_updated BEFORE UPDATE ON meeting_cap_summary
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- comps (C): per-student 🏆 Comps & Projects partial, forward-compatible mirror.
-- The name `projects` is RESERVED for the future canonical cross-student list.
CREATE TABLE IF NOT EXISTS student_comps (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_sheet_id text NOT NULL REFERENCES students(student_sheet_id) ON DELETE CASCADE,
  seq              int  NOT NULL,             -- 0-based ordinal in E:N data block (key + order)
  name             text,                      -- col E, VERBATIM (write-back key; keep trailing space)
  start_date       date,                      -- col F
  end_date         date,                      -- col G
  deadline         date,                      -- col H
  progress         double precision,          -- col I, 0..1 (float8 so PostgREST returns a JS number)
  status           text,                      -- col K
  details          text,                      -- col L
  link             text,                      -- col M
  owner            text,                      -- col N
  project_id       uuid,                      -- forward-compat placeholder, NO FK yet
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (student_sheet_id, seq)
);
CREATE INDEX IF NOT EXISTS student_comps_student_idx ON student_comps (student_sheet_id, seq);
ALTER TABLE student_comps ENABLE ROW LEVEL SECURITY;
DROP TRIGGER IF EXISTS student_comps_set_updated ON student_comps;
CREATE TRIGGER student_comps_set_updated BEFORE UPDATE ON student_comps
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- meetings (B): add the missing FK + date index (converge here; meetings_log retires in Phase 2)
DO $$ BEGIN
  ALTER TABLE meetings ADD CONSTRAINT meetings_student_fk
    FOREIGN KEY (student_sheet_id) REFERENCES students(student_sheet_id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS meetings_student_date_idx ON meetings (student_sheet_id, meeting_date);

-- VERIFIED-SAFE natural keys (0 dups confirmed live 2026-06-27)
ALTER TABLE checkins
  ADD CONSTRAINT checkins_natural_key UNIQUE (student_sheet_id, instructor, submitted_at);
ALTER TABLE transcript_entries
  ADD CONSTRAINT transcript_entries_student_grade_ordinal_key UNIQUE (student_sheet_id, grade_level, ordinal);

COMMIT;

-- ============================================================================
-- PHASE 2 — apply per-domain, each AFTER that domain's backfill/normalization.
-- (Kept here for the record; NOT run by the initial apply.)
-- ============================================================================
-- written_reports: AFTER the clean re-backfill populates sheet_row for every row
-- CREATE UNIQUE INDEX IF NOT EXISTS written_reports_sheet_row_key ON written_reports (sheet_row);
--
-- parent_checkins: AFTER the one-time UNFORMATTED reseed canonicalizes submitted_at
-- ALTER TABLE parent_checkins
--   ADD CONSTRAINT parent_checkins_natural_key UNIQUE (student_sheet_id, parent_email, submitted_at);
--
-- meetings_log: DROP only after (a) backfillPerStudent.cjs meetings_log block removed,
--   (b) 3nf-schema-draft.sql refs removed, (c) grep confirms zero readers
-- DROP TABLE IF EXISTS meetings_log;
