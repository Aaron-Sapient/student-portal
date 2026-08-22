-- The omnibar's portal-docs feed, served by the PORTAL APP (app/api/omnibar/portal-index) instead of
-- the omnibar reading Supabase directly (RLS downgrade, durable form — 2026-08-22, Aaron's call).
-- One row per live, non-empty tab: its latest revision with body. Mirrors exactly what
-- AP-Counseling/06. Scripts/omnibar/build_index.py::fetch_portal assembled from four PostgREST reads.
-- Callable only by the service role (revoked from public/anon/authenticated below).
create or replace function omnibar_portal_index()
returns jsonb
language sql
stable
as $$
  with latest as (
    select distinct on (r.tab_id) r.tab_id, r.id, r.body_md, r.editor_name, r.editor_role, r.created_at
    from md_tab_revisions r
    order by r.tab_id, r.revision desc
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'studentName', coalesce(p.display_name, ''),
           'sheetId',     d.student_sheet_id,
           'slug',        s.slug,
           'title',       (case d.doc_type when 'COMMON_APP' then 'Common App' when 'UC_PIQ' then 'UC PIQs'
                                           when 'SUPPLEMENTAL' then 'Supplements' else 'Document' end) || ' · ' || t.title,
           'tabId',       t.id,
           'docId',       d.id,
           'mtime',       floor(extract(epoch from l.created_at))::bigint,
           'size',        length(l.body_md),
           'words',       array_length(regexp_split_to_array(regexp_replace(l.body_md, '^\s+|\s+$', '', 'g'), '\s+'), 1),
           'author',      coalesce(l.editor_name, ''),
           'authorRole',  coalesce(l.editor_role, ''),
           'body',        l.body_md
         ) order by l.created_at desc), '[]'::jsonb)
  from md_tabs t
  join md_documents d on d.id = t.document_id
  join latest l on l.tab_id = t.id
  left join student_profiles p on p.student_sheet_id = d.student_sheet_id
  left join students s on s.student_sheet_id = d.student_sheet_id
  where t.sync_state is distinct from 'orphaned'
    and regexp_replace(coalesce(l.body_md, ''), '\s', '', 'g') <> '';   -- Python's \S+ word test: any non-whitespace
$$;
revoke execute on function omnibar_portal_index() from public, anon, authenticated;
