-- Standing weekly "project meeting" track — solo-research / project meetings that
-- live OUTSIDE the college-application work, for students who meet a teacher (Aaron
-- today) on a recurring weekly cadence. A THIRD, fully-additive booking track:
--   • Independent of the senior essay cadence (senior_checkin_grants/senior_bookings)
--     and the one-off track (senior_oneoff_grants). A senior whose essay primary is
--     ALSO the project teacher (e.g. Vaibhav/Krrish → Aaron) books project meetings on
--     a SEPARATE ledger, so they never consume essay tokens. Deep-linked as its own
--     path (?m=project:<id>) precisely so a same-teacher/same-length booking can't be
--     mis-charged to the essay grant.
--   • No check-in gate — a standing entitlement, bookable every week regardless of
--     whether the student checked in. 1 booking per Saturday-anchored week per plan.
--   • Works for seniors AND non-seniors (keyed by student_sheet_id / student_email),
--     so it's where solo research belongs once ART becomes group-only (leads/co-leads).
-- Authorization is pure (lib/projectMeetingsCore.js); IO is lib/projectMeetings.js.
-- RLS on with no policies — service-role only, matching the senior_* tables.

-- The per-student standing entitlement (config). One row per recurring meeting.
create table if not exists project_meeting_plans (
  id                uuid primary key default gen_random_uuid(),
  student_sheet_id  text not null,
  student_email     text,                 -- the Clerk-login email — the booking-gate ownership key
  teacher           text not null default 'aaron' check (teacher in ('aaron','ryan')),
  minutes           int  not null,        -- fixed length (no toggle): 15 or 30
  label             text not null,        -- student-facing, e.g. 'Solo Research' / 'Solo Research + Book Project'
  active            boolean not null default true,
  note              text,                 -- admin's reason (optional)
  granted_by        text,                 -- admin email that created the plan
  created_at        timestamptz not null default now()
);
create index if not exists pmp_student_active_idx on project_meeting_plans (student_sheet_id, active);
create index if not exists pmp_email_active_idx on project_meeting_plans (student_email, active);

-- The consumption ledger — one row per booked meeting. The per-week cap is enforced
-- by counting active rows sharing a week_start (the Saturday-anchored week of the
-- meeting date), so cancel/reschedule self-correct. Mirrors senior_bookings.
create table if not exists project_meeting_bookings (
  id                uuid primary key default gen_random_uuid(),
  plan_id           uuid not null references project_meeting_plans (id) on delete cascade,
  student_sheet_id  text not null,
  calendar_event_id text,                 -- the booked event; cleared on cancel
  teacher           text not null,
  meeting_date      date not null,        -- LA calendar day of the meeting
  week_start        date not null,        -- Saturday-anchored week of meeting_date — the 1/week cap key
  minutes           int  not null,
  status            text not null default 'active' check (status in ('active','cancelled')),
  cancelled_at      timestamptz,
  created_at        timestamptz not null default now()
);
create index if not exists pmb_plan_status_idx on project_meeting_bookings (plan_id, status);
create index if not exists pmb_event_idx on project_meeting_bookings (calendar_event_id);
create index if not exists pmb_week_idx on project_meeting_bookings (student_sheet_id, week_start, status);

-- Enforce the 1-per-Saturday-week cap at the DATABASE level, not just the app's
-- check-then-insert (which races under Vercel's parallel serverless). A second active
-- booking for the same plan+week is rejected with a unique violation (Postgres 23505),
-- which bookMeeting catches → rolls back the just-created event → "already booked this week".
create unique index if not exists pmb_one_active_per_week
  on project_meeting_bookings (plan_id, week_start)
  where status = 'active';

alter table project_meeting_plans enable row level security;
alter table project_meeting_bookings enable row level security;
-- No policies on purpose: only the service role reaches these tables.
