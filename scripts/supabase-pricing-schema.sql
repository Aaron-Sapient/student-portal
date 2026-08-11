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

-- 2026-08-11 — the lead→student bridge (applied same day via the pooler).
-- lead_id: provenance link to the AP-project scoreapp_leads row this proposal
-- answers (plain bigint — cross-project FKs don't exist; null = manual
-- referral). provision/provisioned_at: the receipt stamped when a proposal
-- became a student (see app/api/developer/packageQuotes/[id]/provision).
alter table public.package_quotes add column if not exists lead_id        bigint;
alter table public.package_quotes add column if not exists provision      jsonb;
alter table public.package_quotes add column if not exists provisioned_at timestamptz;

-- 2026-08-11 (same session, post-adversarial-review) — config_snapshot: the
-- merged pricing config frozen at save time, so a contract re-derivation can
-- never drift when the pricing dashboard changes between proposal and
-- acceptance. Legacy rows (null) re-derive against the current config, with
-- that risk documented in lib/packageContract.js.
alter table public.package_quotes add column if not exists config_snapshot jsonb;

-- 2026-08-11 (same day) — updated_at: a proposal is now editable in place. The
-- builder offers "update <first name>'s proposal" when the student name already
-- exists, instead of silently inserting a near-duplicate row; four rows for one
-- student accumulated in a single afternoon before this existed. created_at
-- stays the FIRST save, so the Saved tab can show both. Null = never updated.
alter table public.package_quotes add column if not exists updated_at timestamptz;
alter table public.package_quotes add column if not exists updated_by text;
-- previous: the prior CONTENT of a proposal, newest first, capped in code.
-- email_html is the only faithful record of what a family was sent, and Save
-- and Copy are independent buttons in either order, so the app cannot know
-- which stored version was the sent one — which makes keeping them the only
-- correct answer. Mirrors markQuoteProvisioned's receipt chaining.
alter table public.package_quotes add column if not exists previous jsonb;
