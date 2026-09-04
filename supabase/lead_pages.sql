-- Per-lead post-consult pages (/next/<slug>). Idempotent — safe to re-run.
--
-- WHY THIS TABLE EXISTS. The route originally read one JSON file per lead from
-- app/next/leads/ at build time. That cannot ship: a lead file carries a minor's
-- first name, a parent's email address and phone number, and the answers they
-- typed into an intake form, and THIS REPOSITORY IS PUBLIC
-- (github.com/Aaron-Sapient/student-portal). The files are gitignored for the
-- same reason the proposal generator's records are, which left the data with
-- nowhere to live at build time on Vercel: Vercel builds from git, so a
-- gitignored file is simply absent and the page would not exist in production.
--
-- The row is the home. The page reads it per request with the service-role
-- client, so a new family is one INSERT and needs no rebuild and no deploy.
--
-- Same conventions as sat_schema.sql / writing_schema.sql: timestamptz columns,
-- RLS enabled with NO POLICIES, so the ONLY thing that can read or write this
-- table is the service-role client in lib/supabase.js. That matters more here
-- than on any other table in this schema: the student-hubs project's publishable
-- key is student-visible, and these rows contain both a minor's contact details
-- and a family's quoted prices. A single permissive policy on this table would
-- publish every family's pricing to anyone holding that key.
--
-- The slug is the primary key rather than a surrogate uuid because the slug IS
-- the address (<lead>-<6 hex>) and there is exactly one page per slug. The hex
-- is the capability: possession of an unguessable URL is what authorizes a
-- family to read their own page, the same model /write and /proposal already run
-- on, which is why /next/ is Clerk-public in proxy.js.

create table if not exists lead_pages (
  slug       text        primary key,
  data       jsonb       not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table lead_pages enable row level security;

-- No policies, deliberately. Do not add one. If a future surface needs to read a
-- lead page without the service role, it needs its own narrowed view, not a
-- policy on this table.

-- updated_at is maintained by the writer (the seed script upserts it) rather
-- than by a trigger, matching how the rest of this schema handles it: nothing
-- here has an update trigger, and a trigger that exists on one table and not the
-- others is the kind of asymmetry a later session misreads as intentional.
comment on table lead_pages is
  'Per-lead /next/<slug> page data. Service-role only: rows contain a minor''s name, parent contact details and quoted prices. Seeded by scripts/seedLeadPages.mjs from app/next/leads/*.json (gitignored).';
comment on column lead_pages.data is
  'The whole lead JSON, verbatim. Shape is documented by app/next/leads/example-a1b2c3.json, which is the committed template.';

-- ── Booking columns (2026-09-03) ────────────────────────────────────────────
-- Added when the page stopped punting to Calendly and started booking Ryan's
-- own calendar through the portal's engine. The confirmed booking is ALSO
-- merged into `data.booked` so a single row read renders the booked state with
-- no second query; these columns exist so the same fact is queryable without
-- digging through jsonb ("which leads booked this week", "which event id
-- belongs to this family"). The row is the attribution: it is keyed by the
-- slug, which is why nothing in this flow carries a UTM.
--
-- Separate idempotent statements rather than a second create table, so this
-- file stays safe to re-run against a database that already has the table.
alter table lead_pages add column if not exists booked_event_id text;
alter table lead_pages add column if not exists booked_start    timestamptz;
alter table lead_pages add column if not exists booked_at       timestamptz;

-- One booking per lead page, by design: a second confirm RESCHEDULES (the route
-- books the new time, then cancels the old event), so the row holds the current
-- meeting rather than a history. If a history is ever wanted it belongs in its
-- own append-only table, not in a second column here.
comment on column lead_pages.booked_event_id is
  'Google Calendar event id of the CURRENT booking. Replaced on reschedule, not appended.';

create index if not exists lead_pages_booked_start_idx on lead_pages (booked_start);

-- ── Lifecycle (2026-09-03) ──────────────────────────────────────────────────
-- Slugs became first names on 2026-09-03 (Aaron: "conor-c44061 is not as
-- high-touch as /conor"), which makes them guessable and makes retiring one a
-- real operation rather than a theoretical one. A page is CLOSED, never deleted:
-- the family followed a link somebody gave them, so a closed slug renders a
-- quiet notice with a 200. A 404 there would tell a person they typed something
-- wrong when they did not. Only a slug we have never issued 404s.
--
-- Closing is also what frees a first name for the next family with it.
alter table lead_pages add column if not exists status    text        not null default 'active';
alter table lead_pages add column if not exists closed_at timestamptz;

do $$ begin
  alter table lead_pages add constraint lead_pages_status_check
    check (status in ('active', 'closed'));
exception when duplicate_object then null;
end $$;

comment on column lead_pages.status is
  'active | closed. A closed page renders a graceful notice with a 200, never a 404.';
