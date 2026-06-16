-- Supabase schema for the /dev/packages pricing dashboard + proposal builder
-- (student-hubs project, ref zzorytmjnrwckaqryudv). Applied 2026-06-15 via the
-- IPv4 pooler (aws-1-us-east-2.pooler.supabase.com:5432, user
-- postgres.<ref>) — the direct db.<ref>.supabase.co host is IPv6-only.
--
-- Security mirrors document_revisions: RLS enabled, NO policies → only the
-- service-role key (server-side, lib/supabase.js) can read/write; the
-- student-visible publishable key is walled off. Authorization is enforced in
-- the API routes via requireAdmin. Re-running is safe (idempotent).

create table if not exists public.pricing_config (
  id          integer primary key,          -- single active row, id = 1
  config      jsonb not null,
  updated_by  text,
  updated_at  timestamptz not null default now()
);
alter table public.pricing_config enable row level security;

create table if not exists public.package_quotes (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  created_by    text,
  student_name  text,
  grade         text,
  selection     jsonb not null,
  email_html    text
);
alter table public.package_quotes enable row level security;
