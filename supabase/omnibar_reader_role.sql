-- RLS downgrade, step 1+2 (runbook: _notes/rls-downgrade-runbook-2026-08-20.md).
-- A read-only, non-login Postgres role the omnibar will assume via a scoped JWT
-- (role claim = 'omnibar_reader'), replacing the service-role key it runs on today.
-- SELECT on exactly the four tables build_index.py reads. All four have RLS enabled,
-- so each needs an explicit policy for this role or it returns zero rows silently.
-- `using (true)` is correct HERE: the omnibar's own copies serve Aaron/Ryan, who may see
-- every student. The student tier gets a per-subtree predicate later — different job.
create role omnibar_reader nologin noinherit;
grant omnibar_reader to authenticator;
grant usage on schema public to omnibar_reader;
grant select on public.student_profiles, public.md_documents,
                public.md_tabs, public.md_tab_revisions to omnibar_reader;
create policy omnibar_read_all on public.student_profiles  for select to omnibar_reader using (true);
create policy omnibar_read_all on public.md_documents      for select to omnibar_reader using (true);
create policy omnibar_read_all on public.md_tabs           for select to omnibar_reader using (true);
create policy omnibar_read_all on public.md_tab_revisions  for select to omnibar_reader using (true);
