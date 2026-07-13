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
--   odd      : { id, type:'odd', options[], answer, prompt? }   answer = the one real verb (odd one out);
--                                                                prompt overrides the default
--                                                                verb-confusion framing
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

-- ── Seed: Grammar Cumulative Quiz ────────────────────────────────────────────
-- Adds two item types beyond grammar-1 (see lib/satQuiz.js buildGrammarQuiz /
-- scoreGrammarResponses for the full shape + scoring):
--   identify   : { id, type:'identify', choices[], options[], answer } → 4 read-only
--                reference choices, then pick which grammar category they test
--                (answer = the literal option text)
--   first_noun : { id, type:'first_noun', instructions?, parts:[{id,sentence,answer}] } →
--                one dropdown per sentence (populated from that sentence's own words),
--                scored as `parts.length` separate 1-point sub-questions (kept as whole
--                integers — sat_attempts.vocab_score is an int column)
-- Any item may also carry a `badge` string (e.g. "Mod 2") shown as a small tag.
insert into sat_quizzes (slug, title, kind, content, sort_order) values
  ('grammar-cumulative', 'Grammar Cumulative Quiz', 'grammar', '[
    {"id":"i1","type":"identify","choices":["A) hammers","B) to hammer","C) hammering","D) having hammered"],"options":["Verb vs. Not-Verb","Subject-Verb Agreement (singular vs. plural)","Verb Tense"],"answer":"Verb vs. Not-Verb"},
    {"id":"i2","type":"identify","choices":["A) watered","B) will water","C) waters","D) have watered"],"options":["Verb vs. Not-Verb","Subject-Verb Agreement (singular vs. plural)","Verb Tense"],"answer":"Verb Tense"},
    {"id":"i3","type":"identify","choices":["A) type","B) types","C) have typed","D) were typing"],"options":["Verb vs. Not-Verb","Subject-Verb Agreement (singular vs. plural)","Verb Tense"],"answer":"Subject-Verb Agreement (singular vs. plural)"},
    {"id":"i4","type":"identify","choices":["A) is eating","B) are eating","C) were eating","D) have eaten"],"options":["Verb vs. Not-Verb","Subject-Verb Agreement (singular vs. plural)","Verb Tense"],"answer":"Subject-Verb Agreement (singular vs. plural)"},
    {"id":"o1","type":"odd","prompt":"Three of these agree with a singular subject — one agrees with a plural subject (or works as a command). Which is the odd one out?","options":["consider","considers","has considered","was considered"],"answer":"consider"},
    {"id":"f1","type":"fill","sentence":"Mr. _____ for his students, debuted his first lesson last week.","options":["Smith created an impressive SAT grammar curriculum","Smith, created an impressive SAT grammar curriculum,","Smith, creating an impressive SAT grammar curriculum","Smith creating an impressive SAT grammar curriculum,"],"answer":"Smith, creating an impressive SAT grammar curriculum"},
    {"id":"f2","type":"fill","badge":"Mod 2","sentence":"Bob worked all night on the ______ who had been expecting a simple one-pager summarizing the company''s financials that quarter, it was an impressive display.","options":["quarterly report for his boss","quarterly report for his boss,","quarterly report; for his boss,","quarterly report, for his boss;"],"answer":"quarterly report; for his boss,"},
    {"id":"f3","type":"fill","badge":"Mod 2","sentence":"Cool jazz, often represented Birth of the Cool—an album by Miles ______ has become associated with the West Coast.","options":["Davis featured an unconventional nonet","Davis—featuring an unconventional nonet,","Davis, featuring an unconventional nonet—","Davis featuring an unconventional nonet,"],"answer":"Davis featuring an unconventional nonet,"},
    {"id":"f4","type":"fill","sentence":"Intentionally made out of a seemingly cheaper material, _____","options":["the aluminum in the iPhone 17 created frustration among Apple fans.","Apple fans felt frustrated by the aluminum in the iPhone 17.","the iPhone 17''s aluminum frustrated Apple fans.","the iPhone 17 frustrated Apple fans due to its aluminum."],"answer":"the iPhone 17 frustrated Apple fans due to its aluminum."},
    {"id":"fn1","type":"first_noun","instructions":"Select the first noun in each sentence.","parts":[
      {"id":"a","sentence":"Bob''s new grill cooked burgers well.","answer":"grill"},
      {"id":"b","sentence":"the burgers were cooked well on Bob''s new grill.","answer":"burgers"},
      {"id":"c","sentence":"it was Bob''s new grill that cooked burgers well.","answer":"it"},
      {"id":"d","sentence":"Bob bought a new grill that cooked burgers well.","answer":"Bob"}
    ]},
    {"id":"f5","type":"fill","sentence":"Considering that Bluetooth mice and keyboards were horrible in the early days, it''s amazing that ____ so popular with gamers these days.","options":["its","it''s","they''re","their"],"answer":"they''re"}
  ]'::jsonb, 7)
on conflict (slug) do nothing;
