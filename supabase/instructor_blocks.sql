-- instructor_blocks — instructor availability blocks (Aaron / Ryan can't take bookings).
--
-- HISTORY. This table began (2026-06) as a one-way MIRROR of the Master Sheet's
-- `InstructorBlocks` tab, maintained by scripts/reconcileInstructorBlocks.cjs on a
-- 10-minute NAS cron, storing ONE ROW PER DATE (each sheet [startDate..endDate]
-- range expanded). As of 2026-08-09 that mirror is RETIRED and this table is the
-- SOLE SOURCE OF TRUTH, written directly by app/api/developer/blocks. The sheet tab
-- is frozen and read by nothing.
--
-- SHAPE CHANGE that came with it: one row per BLOCK (a date RANGE), not one row per
-- date. `block_date` is the range start and `end_date` the inclusive end; a single-day
-- block has end_date = block_date. This matches what the admin UI actually creates, so
-- delete-by-id is exactly "remove the block I made". The read predicates in
-- lib/blocks.js (isDateBlocked / blockedWindowsForDate) were always range-native —
-- they were written for the Sheets range shape — so they needed no change.
--
-- NOTE: this DDL was derived from the live database (\d instructor_blocks) on
-- 2026-08-09, not hand-written from memory. RLS is ENABLED with ZERO policies, which
-- means anon/authenticated cannot read or write at all; access is service-role only
-- (the app uses SUPABASE_SERVICE_ROLE_KEY server-side). That is deliberate — blocks
-- are internal scheduling data and no browser should reach them directly.

-- ── Base table (current live state as of 2026-08-09) ───────────────────────────
-- create type instructor as enum ('aaron', 'ryan', 'art');
--
-- create table if not exists instructor_blocks (
--   id          uuid primary key default gen_random_uuid(),
--   instructor  instructor  not null,
--   block_date  date        not null,
--   start_time  time,                    -- NULL/NULL = full-day block
--   end_time    time,
--   reason      text,
--   created_at  timestamptz not null default now()
-- );
-- create index instructor_blocks_idx on instructor_blocks (instructor, block_date);
-- alter table instructor_blocks enable row level security;

-- ── 2026-08-09 migration: per-date rows → date ranges ─────────────────────────
-- Deliberately three statements, not one. `end_date` is added NULLABLE, backfilled,
-- and only then made NOT NULL — and it gets NO DEFAULT. That last part is the point:
-- any writer that still thinks this table is per-date supplies no end_date, so its
-- INSERT fails loudly instead of silently writing a one-day row that under-blocks the
-- calendar. A default would convert a loud bug into a wrong answer.
alter table instructor_blocks add column if not exists end_date date;

update instructor_blocks set end_date = block_date where end_date is null;

alter table instructor_blocks alter column end_date set not null;

-- Ordering guard: an inverted range would silently block nothing at all, because
-- isDateBlocked tests `target >= start && target <= end`.
alter table instructor_blocks
  add constraint instructor_blocks_date_order check (end_date >= block_date);

-- Sanity guard on span. The per-date expansion used to cap its loop at 400 days
-- (scripts/reconcileInstructorBlocks.cjs, lib/blocks.js), which quietly bounded the
-- damage of a typo'd year. Ranges have no loop and therefore no such cap, so the
-- bound moves into the schema: a fat-fingered "2027" now errors instead of blocking
-- a year of availability.
alter table instructor_blocks
  add constraint instructor_blocks_span_sane
  check (end_date < block_date + 400);

-- Time window is all-or-nothing: both NULL (full-day block) or both set (partial).
-- lib/blocks.js gates on `b.startTime && b.endTime`, so a half-set window would read
-- as a full-day block — a silent over-block. Enforce the invariant at the boundary.
alter table instructor_blocks
  add constraint instructor_blocks_window_paired
  check ((start_time is null) = (end_time is null));
