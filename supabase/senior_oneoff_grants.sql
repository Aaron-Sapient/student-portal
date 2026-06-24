-- One-off "extra meeting" grants for seniors — a SEPARATE, ADDITIVE track from the
-- deterministic weekly college-application cadence (senior_checkin_grants). An admin
-- grants ONE extra meeting with a chosen teacher + length, bookable within a window;
-- it does NOT touch the weekly grant's tokens / cross-meeting math. Authorization is a
-- FALLBACK in canBookOnDate (the weekly cadence is tried first, so the one-off is only
-- spent on a meeting the weekly grant can't cover). Consumed on its own ledger and
-- returned (status → active, event cleared) on cancel. See lib/seniors.js + seniorsCore.js.
create table if not exists senior_oneoff_grants (
  id                uuid primary key default gen_random_uuid(),
  student_sheet_id  text not null,
  student_email     text,
  teacher           text not null check (teacher in ('aaron','ryan')),
  minutes           int  not null,
  valid_from        date not null,        -- LA calendar day; earliest bookable date (inclusive)
  valid_through     date not null,        -- LA calendar day; latest bookable date (inclusive)
  note              text,                 -- admin's reason (optional)
  granted_by        text,                 -- admin email that issued the grant
  granted_at        timestamptz not null default now(),
  status            text not null default 'active' check (status in ('active','consumed','cancelled')),
  calendar_event_id text,                 -- set when consumed (the booked event); cleared on cancel
  created_at        timestamptz not null default now()
);
create index if not exists sog_student_status_idx on senior_oneoff_grants (student_sheet_id, status);
create index if not exists sog_event_idx on senior_oneoff_grants (calendar_event_id);

alter table senior_oneoff_grants enable row level security;
-- No policies on purpose: only the service role reaches this table (matches the other senior_* tables).
