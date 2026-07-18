-- Autonomous meeting-compliance outreach log (senior essay track).
--
-- One row per nudge decision. The unique key (student_sheet_id, week_start, kind)
-- is the ATOMIC once-per-week-per-student dedup for the essay nudge: the send path
-- does INSERT ... ON CONFLICT DO NOTHING and only emails when the insert took, so a
-- double-fired cron can never double-email. The Phase-0 digest does NOT write here
-- (it's read-only reporting).
--
-- `kind`:    'essay_nudge' (live) | 'essay_nudge_dryrun' (kill-switch off) — distinct
--            kinds so a silent dry-run never occupies the live dedup slot.
-- `channel`: 'AUTONOMOUS' (real send via lib/autonomousEmail.js) | 'DRYRUN'.
--
-- Service-role only (RLS on, no policies), matching the other Bucket-A mirrors in
-- lib/supabase.js. See the plan: this-roleplay-revealed-a-jaunty-quokka.md.
create table if not exists outreach_log (
  id               uuid primary key default gen_random_uuid(),
  student_sheet_id text not null,
  week_start       date not null,
  kind             text not null,
  channel          text,
  recipient_emails text[],
  subject          text,
  sent_at          timestamptz not null default now(),
  meta             jsonb,
  unique (student_sheet_id, week_start, kind)
);

alter table outreach_log enable row level security;
-- No policies on purpose: only the service role (server) may read/write.
