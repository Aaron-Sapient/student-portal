-- meeting_cap_summary_aaron_weekly.sql (2026-07-14)
-- meeting_cap_summary had no column for Aaron's cap usage — only Ryan's
-- (meetings_used/meetings_allowed, monthly). Aaron's cap is WEEKLY (Master
-- '✅ Check-Ins' cols N/O), never mirrored (backfillCheckinSummary.cjs only
-- reads A:M). Additive, nullable, idempotent — no data/behavior change on apply.
ALTER TABLE meeting_cap_summary ADD COLUMN IF NOT EXISTS meetings_used_weekly_aaron    integer;
ALTER TABLE meeting_cap_summary ADD COLUMN IF NOT EXISTS meetings_allowed_weekly_aaron integer;
