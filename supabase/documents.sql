-- Student file delivery — consultant design adopted verbatim 2026-08-27
-- (Clauni/briefs/2026-08-27-A4-consultant-file-system.md §2–§3).
-- GATED ON AARON: NOT applied. Apply via the session pooler (see .claude/CLAUDE.md):
--   psql "host=aws-1-us-east-2.pooler.supabase.com port=5432 user=postgres.zzorytmjnrwckaqryudv dbname=postgres" -f supabase/documents.sql
--
-- Substitution, noted: the brief's `student_guardians (student_id, email)` is NOT
-- created. The live `guardians` table (id, student_sheet_id, email, ordinal —
-- REST-verified 2026-08-27, populated) already carries the parent↔student link
-- and is what the parent portal resolves through; lib/studentFiles.js joins it
-- via students.student_sheet_id. Creating a second link table would be a
-- duplicate source of truth.

create table if not exists documents (
  id            uuid primary key default gen_random_uuid(),
  student_id    uuid not null references students(id) on delete restrict,
  slug          text not null,                 -- from the filename: "college-list-v2"
  title         text not null,                 -- what the student sees in the list
  kind          text not null check (kind in ('html','markdown','pdf')),
  body          text,                          -- html/md bytes, when <= 1 MB
  storage_path  text,                          -- bucket path, when pdf or > 1 MB
  body_sha256   text not null,                 -- for idempotent pushes
  editable      boolean not null default false,
  pushed_at     timestamptz not null default now(),
  pushed_by     text not null,                 -- staff email
  unique (student_id, slug),
  check ((body is null) <> (storage_path is null))   -- exactly one home for the bytes
);

create table if not exists document_edits (
  document_id   uuid primary key references documents(id) on delete cascade,
  body          text not null,                 -- the student's working copy
  edited_at     timestamptz not null default now(),
  edited_by     text not null
);

-- §3: RLS on, NO policies — deny-all for the anon/publishable key. The only
-- reader is the Next.js server holding the service-role key, behind canAccess().
alter table documents      enable row level security;
alter table document_edits enable row level security;

-- One private Storage bucket for pdf / >1 MB bodies. Reads go through signed URLs
-- the server issues after the access check; no public access, no anon policy.
insert into storage.buckets (id, name, public)
values ('documents', 'documents', false)
on conflict (id) do nothing;
