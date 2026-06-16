-- ============================================================================
-- writing_schema.sql — the portal markdown word processor's storage.
-- Project: student-hubs (ref zzorytmjnrwckaqryudv). Server-side SERVICE ROLE only
-- (RLS enabled, no policies) — exactly like document_revisions. Idempotent /
-- re-runnable. Apply via the SESSION POOLER (the direct db.<ref> host is
-- IPv6-only and unreachable from the Macs):
--
--   PGPASSWORD="$(sed -n 's/^- Database password: //p' \
--     ~/.claude/secrets/supabase-admissions-partners/student-hubs.txt)" \
--   psql "host=aws-1-us-east-2.pooler.supabase.com port=5432 \
--     user=postgres.zzorytmjnrwckaqryudv dbname=postgres" \
--     -f supabase/writing_schema.sql
-- ============================================================================

-- shared updated_at trigger (matches the AP-Counseling convention)
create or replace function set_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

-- 3 logical documents per student: Common App, UC PIQs, Supplementals.
do $$ begin
  create type md_doc_type as enum ('COMMON_APP','UC_PIQ','SUPPLEMENTAL');
exception when duplicate_object then null; end $$;

create table if not exists md_documents (
  id               uuid primary key default gen_random_uuid(),
  student_sheet_id text        not null,
  student_email    text        not null,
  doc_type         md_doc_type not null,
  created_at       timestamptz not null default now(),
  unique (student_sheet_id, doc_type)
);

-- Tabs: STABLE backend id (opaque to the editor widget), renamable display title,
-- optional college linkage for the synced Supplementals doc.
create table if not exists md_tabs (
  id            uuid        primary key default gen_random_uuid(),
  document_id   uuid        not null references md_documents(id) on delete cascade,
  title         text        not null,
  origin        text        not null default 'manual'
                  check (origin in ('synced','manual')),
  -- for synced tabs: a key derived from the originating list entry (college name
  -- or PIQ prompt #). NULL for manual tabs. Match sync on THIS, never the title.
  sync_key      text,
  sync_state    text        not null default 'manual_active'
                  check (sync_state in ('active','orphaned','manual_active')),
  sort_key      double precision not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
-- one synced tab per (doc, key); partial so manual NULL-key rows never collide.
create unique index if not exists md_tabs_one_per_key
  on md_tabs(document_id, sync_key) where sync_key is not null;
create index if not exists md_tabs_doc_sort_idx on md_tabs(document_id, sort_key);

drop trigger if exists md_tabs_set_updated on md_tabs;
create trigger md_tabs_set_updated before update on md_tabs
  for each row execute function set_updated_at();

-- Append-only revisions. Current body = latest revision. Editor identity stamped
-- SERVER-SIDE (never trusted from the client). MAX(rev)+1 with a 23505 retry,
-- exactly like document_revisions.
create table if not exists md_tab_revisions (
  id            uuid        primary key default gen_random_uuid(),
  tab_id        uuid        not null references md_tabs(id) on delete cascade,
  revision      integer     not null,
  body_md       text        not null default '',
  source        text        not null default 'edit'
                  check (source in ('baseline','edit','restore')),
  editor_email  text        not null,
  editor_role   text        not null check (editor_role in ('student','admin')),
  editor_name   text,
  note          text,
  created_at    timestamptz not null default now(),
  unique (tab_id, revision)
);
create index if not exists md_tab_revisions_tab_rev_idx
  on md_tab_revisions(tab_id, revision desc);

-- College-list mirror. The NAS cron upserts the full parseCollegeGrid() payload
-- per senior from their Google Sheet; the app reads it instead of live Sheets.
create table if not exists student_college_lists (
  student_sheet_id text        primary key,
  student_email    text,
  payload          jsonb       not null,
  updated_at       timestamptz not null default now()
);
drop trigger if exists scl_set_updated on student_college_lists;
create trigger scl_set_updated before update on student_college_lists
  for each row execute function set_updated_at();

alter table md_documents          enable row level security;
alter table md_tabs               enable row level security;
alter table md_tab_revisions      enable row level security;
alter table student_college_lists enable row level security;
-- No policies on purpose: only the service role reaches these tables.
