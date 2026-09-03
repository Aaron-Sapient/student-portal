-- bookings — the RECORD of every STANDARD (Ryan/Aaron) and ART meeting.
--
-- Package C of the zero-Google sweep (ruling 2026-08-27, .claude/CLAUDE.md §Data (d)):
-- Google Calendar stays the one accepted dependency — the EVENT still lives there —
-- but the record of a booking belongs in Postgres, so a Calendar outage degrades
-- scheduling, never data. Before this table the standard/ART track's whole state
-- was a Calendar event (SUMMER-EXIT.md W3, "nowhere in Postgres").
--
-- Mirrors the two tables that already do this job for the other tracks:
-- project_meeting_bookings (supabase/project_meetings.sql) and senior_bookings
-- (supabase/writing_schema.sql). Those two keep their own ledgers; this table is
-- ONLY for bookings that have no other ledger (bookMeeting's `!senior && !projectPlanId`
-- path). Readers union all three (lib/bookings.js listStudentBookings).
--
-- Write order (app/api/bookMeeting): INSERT this row FIRST, then create the Calendar
-- event, then attach calendar_event_id. A row with calendar_event_id NULL and
-- status 'active' is a booking whose event is still pending — scripts/reconcileBookings.cjs
-- enumerates those (never a silent waiting set).
--
-- External writer: Aaron hand-edits events on the calendar (drags, deletes). The
-- Calendar → Postgres direction is scripts/reconcileBookings.cjs; without it this
-- ledger drifts exactly as project_meeting_bookings did.
--
-- Apply via the session pooler (see .claude/CLAUDE.md "Apply SQL via the session pooler").
-- NOT applied by the implementer — gated on Aaron.

create table if not exists bookings (
  id                uuid primary key default gen_random_uuid(),
  student_sheet_id  text not null references students(student_sheet_id) on delete cascade,
  student_id        uuid,                  -- students.id, denormalized for the native key (no FK: students.id uniqueness not asserted in any migration here)
  student_email     text,                  -- the Clerk-login email at booking time (portal provenance, same value as the event's extendedProperties.private.studentEmail)
  instructor        text not null check (instructor in ('ryan','aaron')),   -- the HUMAN whose calendar holds the event (ART rides Aaron's)
  track             text not null default 'standard' check (track in ('standard','art')),
  calendar_id       text,                  -- which calendar the event is on (GOOGLE_CALENDAR_ID_*)
  calendar_event_id text,                  -- NULL until the event exists ("calendar sync pending")
  meeting_date      date not null,         -- LA calendar day of the meeting
  start_time        timestamptz not null,
  end_time          timestamptz not null,
  minutes           int  not null,
  agenda            text,                  -- what the student typed (or the type default); was written to CheckinForm col J/H before this table
  status            text not null default 'active' check (status in ('active','cancelled')),
  cancelled_at      timestamptz,
  source            text not null default 'portal' check (source in ('portal','backfill','reconcile')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  -- Postgres allows many NULLs under UNIQUE, so pending rows never collide; the
  -- backfill and reconcile are re-runnable via ON CONFLICT (calendar_event_id) DO NOTHING.
  unique (calendar_event_id)
);

create index if not exists bookings_student_date_idx on bookings (student_sheet_id, meeting_date);
create index if not exists bookings_status_date_idx  on bookings (status, meeting_date);
-- The "calendar sync pending" set, enumerable in one index scan.
create index if not exists bookings_pending_event_idx on bookings (created_at)
  where status = 'active' and calendar_event_id is null;

-- RLS on, NO policies — DELIBERATE. Only the service role (the app's server-side
-- client, lib/supabase.js) can read or write this table; the student-visible
-- publishable key gets `200 []`. No anon policy is ever added: authorization is
-- the Clerk session → students row check inside the API routes, matching every
-- other booking ledger (project_meeting_bookings, senior_bookings, booking_tokens).
alter table bookings enable row level security;

comment on table bookings is
  'Record of standard (Ryan/Aaron) + ART bookings. Calendar holds the event; this row is the truth. RLS enabled with no policies on purpose — service role only.';
comment on column bookings.calendar_event_id is
  'NULL = event not yet created (Calendar was down at booking time). scripts/reconcileBookings.cjs lists/pushes these.';
comment on column bookings.source is
  'portal = written by bookMeeting; backfill = scripts/backfillBookings.cjs from historical events; reconcile = scripts/reconcileBookings.cjs.';
