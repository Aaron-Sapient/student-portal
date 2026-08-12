-- cross_month_override — keeps an UNSPENT monthly cross-meeting alive across a
-- superseding check-in.
--
-- THE BUG THIS FIXES. Whether a grant carries the once-a-month secondary-teacher
-- meeting is DERIVED from its week_start (seniorsCore.phaseWeekMonthKey → whichever
-- of the grant's two Saturday-weeks is the student's phase week). A new check-in
-- supersedes the prior grant unconditionally (seniors.createCheckinGrant). So a
-- student who checks in again while the old grant is STILL LIVE and still owes an
-- unbooked cross-meeting silently loses it: the successor grant's own weeks aren't
-- the phase week, so the secondary teacher becomes 'wrong-teacher' on every date and
-- the entitlement cannot be recovered by any student action.
-- Measured 2026-08-11: 4 occurrences since June across 18 active seniors.
--
-- WHY A COLUMN AND NOT A ONE-OFF GRANT. Issuing a senior_oneoff_grants row would be
-- a LOOK-ALIKE, not the same entitlement: one-off bookings write no senior_bookings
-- row, so they are invisible to the month-level `crossMeetings` check that enforces
-- "one cross-meeting per calendar month" — the student could then take the carried
-- meeting AND that month's regular cross. The override keeps it the SAME entitlement,
-- so capacity reservation, once-a-month enforcement, the gold phase week and the
-- cross card all keep working with no further change.
--
-- SEMANTICS. 'yyyy-LL' (e.g. '2026-08') — the calendar month the carried cross-meeting
-- belongs to; null for the overwhelming majority of grants. Read by
-- seniorsCore.phaseWeekMonthKey, which returns it when the grant's own window contains
-- no phase week. Carried forward automatically on each further supersede (the outgoing
-- grant's phaseWeekMonthKey already resolves to the override), and dropped as soon as
-- the cross is booked or the successor grant naturally carries the same month.
-- The CHECK matters: grantCarriesCrossMeeting is `phaseWeekMonthKey(...) != null`, so
-- ANY non-null string makes a grant carry a cross forever, while crossMeetingDone's
-- 'yyyy-LL' comparison could never match it — a malformed value is an unspendable,
-- permanent entitlement rather than a visible error.
alter table senior_checkin_grants
  add column if not exists cross_month_override text;

alter table senior_checkin_grants
  drop constraint if exists scg_cross_month_override_fmt;
alter table senior_checkin_grants
  add constraint scg_cross_month_override_fmt
  check (cross_month_override is null or cross_month_override ~ '^\d{4}-\d{2}$');

comment on column senior_checkin_grants.cross_month_override is
  'yyyy-LL month of a cross-meeting carried over from a superseded still-live grant; null normally. See supabase/senior_cross_month_override.sql.';
