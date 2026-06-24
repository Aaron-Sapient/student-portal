-- SAT practice surface (public, no-auth /sat route). Idempotent — safe to re-run.
--
-- Three tables, same conventions as writing_schema.sql / students_hub_schema.sql:
-- uuid PKs via gen_random_uuid(), timestamptz created_at, RLS enabled with NO
-- policies (only the service-role client in lib/supabase.js reaches these).
--
-- Expandable by design: add another vocab quiz with a single INSERT into
-- sat_quizzes (kind='vocab'); add a grammar quiz with kind='grammar' + a
-- grammar-shaped content blob (and a renderer branch in lib/satQuiz.js).

-- ── Roster ──────────────────────────────────────────────────────────────────
create table if not exists sat_students (
  id         uuid        primary key default gen_random_uuid(),
  name       text        not null unique,   -- unique => seed is idempotent
  active     boolean     not null default true,
  created_at timestamptz not null default now()
);
alter table sat_students enable row level security;

-- ── Quiz registry + content (the "expandable" part) ─────────────────────────
-- content (vocab): jsonb array of { word, definition, connotation }, where
-- connotation ∈ 'positive' | 'neutral' | 'negative'.
create table if not exists sat_quizzes (
  id         uuid        primary key default gen_random_uuid(),
  slug       text        not null unique,
  title      text        not null,
  kind       text        not null,          -- 'vocab' now; 'grammar' later
  content    jsonb       not null,
  active     boolean     not null default true,
  sort_order int         not null default 0,
  created_at timestamptz not null default now()
);
alter table sat_quizzes enable row level security;

-- ── Saved scores (one attempt per student per quiz) ─────────────────────────
-- vocab_score is the primary score for any kind; connotation_score is vocab's
-- SECOND sub-score and is null for kinds with a single axis (grammar). total is
-- the question count. answers holds the full per-question review record so a
-- locked (already-taken) attempt can be re-rendered without recomputation.
create table if not exists sat_attempts (
  id                uuid        primary key default gen_random_uuid(),
  student_id        uuid        not null references sat_students(id) on delete cascade,
  quiz_id           uuid        not null references sat_quizzes(id) on delete cascade,
  vocab_score       int         not null,
  connotation_score int,                      -- null for single-axis kinds (grammar)
  total             int         not null,
  answers           jsonb       not null,
  created_at        timestamptz not null default now(),
  unique (student_id, quiz_id)              -- enforces one attempt per student
);
create index if not exists sat_attempts_student_idx on sat_attempts (student_id);
alter table sat_attempts enable row level security;
-- Migrate an already-deployed table (created when connotation_score was NOT NULL).
alter table sat_attempts alter column connotation_score drop not null;

-- ── Seed: roster ────────────────────────────────────────────────────────────
insert into sat_students (name) values
  ('Aaron Blumenthal'),      -- instructor (Aaron) — manual QA of each quiz, 2026-06-24
  ('Aarav Jain'),
  ('Doudou Shen'),
  ('Riti Nalabolu'),
  ('Tarit Voni'),
  ('Vedant Narayansa'),
  ('Yashas Gangireddy')      -- added by admin without notice (Aaron, 2026-06-24)
on conflict (name) do nothing;

-- ── Seed: Vocab Quiz 1 ──────────────────────────────────────────────────────
-- 8 words (the 2 mis-defined source words, Cursory & Dolorous, are intentionally
-- omitted — students studied wrong definitions for those; Aaron fixes in class).
insert into sat_quizzes (slug, title, kind, content, sort_order) values
  ('vocab-1', 'Vocab Quiz 1', 'vocab', '[
    {"word":"Ancillary","definition":"Secondary; yet inseparably associated; carrying out of the primary objective","connotation":"neutral"},
    {"word":"Cajole","definition":"To convince someone pleasantly but persistently","connotation":"neutral"},
    {"word":"Cloister","definition":"To shut someone into a sanctuary; literally, a walkway in a monastery","connotation":"neutral"},
    {"word":"Elicit","definition":"To act in a way that invites a specific response","connotation":"neutral"},
    {"word":"Ephemeral","definition":"Short-lived and tends to disappear","connotation":"neutral"},
    {"word":"Facetious","definition":"Making light of a serious situation","connotation":"negative"},
    {"word":"Frenetic","definition":"Frenzied and uncontrolled","connotation":"negative"},
    {"word":"Garrulous","definition":"Prone to talking at length about unimportant things","connotation":"negative"}
  ]'::jsonb, 1)
on conflict (slug) do nothing;

-- ── Seed: Grammar Quiz 1 (Verb Confusion) ───────────────────────────────────
-- kind='grammar'. content = ordered array of question items (order preserved by
-- buildGrammarQuiz; see lib/satQuiz.js for the shape + scoring).
--   classify : { id, type:'classify', word, answer }          answer ∈ verb | not_verb
--   fill     : { id, type:'fill', sentence, options[], answer } answer = the literal option text
--   odd      : { id, type:'odd', options[], answer }            answer = the one real verb (odd one out)
-- 3 classify (verb vs not-verb), 3 fill-in-the-blank (correct form), 1 odd-one-out 3v1.
insert into sat_quizzes (slug, title, kind, content, sort_order) values
  ('grammar-1', 'Grammar Quiz 1', 'grammar', '[
    {"id":"c1","type":"classify","word":"thinks","answer":"verb"},
    {"id":"c2","type":"classify","word":"thinking","answer":"not_verb"},
    {"id":"c3","type":"classify","word":"eaten","answer":"not_verb"},
    {"id":"f1","type":"fill","sentence":"James, ______ toward the ice cream truck, tripped on his shoelaces.","options":["running","ran","runs","run"],"answer":"running"},
    {"id":"f2","type":"fill","sentence":"The old bridge ______ under the weight of the heavy truck.","options":["collapsed","collapsing","to collapse","having collapsed"],"answer":"collapsed"},
    {"id":"f3","type":"fill","sentence":"The students ______ in the front row answered every question correctly.","options":["sitting","sat","sit","will sit"],"answer":"sitting"},
    {"id":"o1","type":"odd","options":["to swim","running","to bake","writes"],"answer":"writes"}
  ]'::jsonb, 2)
on conflict (slug) do nothing;
