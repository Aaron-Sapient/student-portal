-- omnibar_roster.sql — the AP omnibar's ROSTER feed (student + guardian emails).
--
-- Aaron's ruling 2026-09-10: the omnibar's custom surfaces are DECOUPLED FROM GOOGLE. The Email List
-- panel (index.html, pane `emails`) must never read the Master Sheet at render time; the portal's
-- Supabase roster is the source of truth. Sheets still touches these two tables in exactly one place —
-- scripts/backfillStudents.cjs, run by the reconcile cron — and nothing downstream of that reads Sheets.
--
-- Served by app/api/omnibar/roster, the second member of the /api/omnibar/* family (same bearer gate as
-- portal-index, lib/omnibarAuth). The omnibar copies hold ONLY that token, no Supabase credential —
-- which is the whole reason this is a portal route and not a direct PostgREST read (RLS downgrade,
-- 2026-08-22). Callable only by the service role, same as omnibar_portal_index().
--
-- Shape (one object per student, name-ordered — build_index.py::fetch_roster consumes it verbatim):
--   { sheetId, name, class, slug, status, email, parents: [p1, p2] }
-- `parents` is guardian-ordinal ordered, so parent 1 precedes parent 2 the way Master cols K/L do.
-- Empty string, never null, for the scalar fields: the page joins them into address lists and a null
-- would print as "null". A student with no email yields '' and is dropped client-side.
create or replace function omnibar_roster()
returns jsonb
language sql
stable
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'sheetId', s.student_sheet_id,
           'name',    coalesce(s.name, ''),
           'class',   coalesce(s.class, ''),
           'slug',    coalesce(s.slug, ''),
           'status',  coalesce(s.status, ''),
           'email',   coalesce(s.student_email, ''),
           'parents', coalesce((
             select jsonb_agg(g.email order by g.ordinal)
             from guardians g
             where g.student_sheet_id = s.student_sheet_id
               and g.email like '%@%'
           ), '[]'::jsonb)
         ) order by s.name), '[]'::jsonb)
  from students s;
$$;
revoke execute on function omnibar_roster() from public, anon, authenticated;
