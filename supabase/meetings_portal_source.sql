-- Meetings log: per-student source-of-truth "booster" (2026-08-21, Aaron's call).
-- students.meetings_source = 'sheet' (default; the NAS cron mirrors the 📆 Meetings tab)
--                          | 'portal' (the portal writes the log; the cron skips this
--                            student's meetings entirely — no upsert, no prune).
-- Detach (when every student is 'portal'): drop the column + the cron's meetings step.
-- ⚠ One-way door: flipping a student back to 'sheet' would let the cron prune every
-- portal-written row (seq >= the sheet's row count). The prune also skips source='portal'
-- rows unconditionally as a belt-and-braces guard.
alter table students
  add column if not exists meetings_source text not null default 'sheet'
  constraint students_meetings_source_chk check (meetings_source in ('sheet','portal'));

alter table meetings
  add column if not exists source text not null default 'sheet'
  constraint meetings_source_chk check (source in ('sheet','portal')),
  add column if not exists voided_at timestamptz;   -- soft delete for portal rows (undo path)

-- A portal-written row is one per (student, day, teacher): the second "new meeting" click
-- finds the first instead of duplicating it.
create unique index if not exists meetings_portal_day_uk
  on meetings (student_sheet_id, meeting_date, teacher)
  where source = 'portal' and voided_at is null;

-- Atomic find-or-create: serializes per student (advisory lock) so two concurrent
-- "new meeting" requests can neither duplicate the row nor collide on seq.
create or replace function portal_meeting_for_day(p_sheet_id text, p_date date, p_teacher text)
returns meetings
language plpgsql
as $$
declare
  r meetings;
begin
  perform pg_advisory_xact_lock(hashtext('meetings:' || p_sheet_id));
  if (select meetings_source from students where student_sheet_id = p_sheet_id) is distinct from 'portal' then
    raise exception 'student % is not portal-owned for meetings', p_sheet_id using errcode = 'P0001';
  end if;
  select * into r from meetings
   where student_sheet_id = p_sheet_id and meeting_date = p_date and teacher = p_teacher
     and source = 'portal' and voided_at is null
   limit 1;
  if found then return r; end if;
  insert into meetings (student_sheet_id, seq, meeting_date, teacher, source)
  values (p_sheet_id,
          (select coalesce(max(seq), -1) + 1 from meetings where student_sheet_id = p_sheet_id),
          p_date, p_teacher, 'portal')
  returning * into r;
  return r;
end $$;

update students set meetings_source = 'portal' where slug = 'isaac-lee-27';
