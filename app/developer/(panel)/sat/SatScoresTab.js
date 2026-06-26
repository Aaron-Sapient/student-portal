'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, Check, ChevronRight, X } from 'lucide-react';
import { PageHeader, TabSkeleton, ErrorNote, EmptyNote } from '../devUi';

// The SAT tab: every active SAT student as a container card (overall score ring +
// per-quiz chips at a glance). Clicking a card navigates to ?student=<slug> — a
// real, linkable detail VIEW (not a modal) showing a scores-over-time trend chart
// (vocab vs grammar, modeled on the home DeltaLines) + a per-question breakdown.
// Vocab quizzes score two axes (definition/word match + connotation); grammar
// scores one (stored in vocabScore, connotationScore null) — see lib/satQuiz.js.

const shortTitle = (t) =>
  String(t || '').replace(/\s*quiz\s*/i, ' ').replace(/\s+/g, ' ').trim();

// URL slug from a name ("Aarav Jain" → "aarav-jain"). Matching also accepts the
// bare first name (?student=aarav) for convenience.
const studentSlug = (name) =>
  String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function fmtDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return iso;
  }
}

// Per-attempt correct/possible. Vocab has two axes → 2× the question count.
function attemptStats(a) {
  if (a.kind === 'vocab') {
    return { correct: (a.vocabScore || 0) + (a.connotationScore || 0), possible: a.total * 2 };
  }
  return { correct: a.vocabScore || 0, possible: a.total };
}

function overall(attempts) {
  let correct = 0;
  let possible = 0;
  for (const a of attempts) {
    const s = attemptStats(a);
    correct += s.correct;
    possible += s.possible;
  }
  return { correct, possible, pct: possible > 0 ? Math.round((correct / possible) * 100) : null };
}

const pct = (correct, possible) => (possible > 0 ? Math.round((correct / possible) * 100) : null);
const attemptPct = (a) => {
  const s = attemptStats(a);
  return pct(s.correct, s.possible) ?? 0;
};
const toneFor = (p) => (p == null ? 'muted' : p >= 80 ? 'moss' : 'ochre');

const TONE_TEXT = { moss: 'text-moss', ochre: 'text-ochre', muted: 'text-ink-faint' };
const TONE_BG = {
  moss: 'bg-moss/[0.14] text-moss',
  ochre: 'bg-ochre/[0.16] text-ochre',
  muted: 'bg-ink-faint/[0.12] text-ink-soft',
};

// ── At-a-glance bits ─────────────────────────────────────────────────────────
function ScoreRing({ value, tone }) {
  return (
    <div
      className={`neu-inset flex h-14 w-14 shrink-0 flex-col items-center justify-center rounded-full ${TONE_TEXT[tone]}`}
    >
      <span className="font-display text-[1.05rem] font-semibold leading-none tabular-nums">
        {value == null ? '—' : value}
      </span>
      {value != null && <span className="text-[8px] font-bold leading-none opacity-70">%</span>}
    </div>
  );
}

function QuizChip({ attempt }) {
  const p = attemptPct(attempt);
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-[10px] font-bold uppercase leading-none tracking-[0.06em] ${TONE_BG[toneFor(p)]}`}
    >
      {shortTitle(attempt.title)} · {p}%
    </span>
  );
}

function UntakenChip({ title }) {
  return (
    <span className="inline-flex items-center rounded-full bg-ink-faint/[0.08] px-2.5 py-1 text-[10px] font-bold uppercase leading-none tracking-[0.06em] text-ink-faint/70">
      {shortTitle(title)} · —
    </span>
  );
}

function StudentScoreCard({ student, quizzes, onOpen }) {
  const ov = overall(student.attempts);
  const has = student.attempts.length > 0;
  return (
    <div
      role={has ? 'button' : undefined}
      tabIndex={has ? 0 : undefined}
      onClick={has ? onOpen : undefined}
      onKeyDown={has ? (e) => (e.key === 'Enter' || e.key === ' ') && onOpen() : undefined}
      className={`neu-raised flex items-center gap-4 rounded-[1.5rem] px-5 py-4 transition ${
        has ? 'cursor-pointer active:scale-[0.995]' : 'opacity-70'
      }`}
    >
      <ScoreRing value={ov.pct} tone={toneFor(ov.pct)} />
      <div className="min-w-0 flex-1">
        <p className="truncate font-display text-[1.05rem] font-semibold text-ink">{student.name}</p>
        {has ? (
          <>
            <p className="mt-0.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-faint">
              {ov.correct}/{ov.possible} correct · {student.attempts.length} of {quizzes.length}{' '}
              quizzes
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {quizzes.map((q) => {
                const a = student.attempts.find((x) => x.slug === q.slug);
                return a ? (
                  <QuizChip key={q.slug} attempt={a} />
                ) : (
                  <UntakenChip key={q.slug} title={q.title} />
                );
              })}
            </div>
          </>
        ) : (
          <p className="mt-0.5 text-[12px] text-ink-faint">No quizzes taken yet</p>
        )}
      </div>
      {has && <ChevronRight className="h-4 w-4 shrink-0 text-ink-faint" strokeWidth={2.2} />}
    </div>
  );
}

// ── Scores-over-time trend (vocab vs grammar) ────────────────────────────────
// Modeled on the home DeltaLines: a distorted 100×100 viewBox (preserveAspectRatio
// none + non-scaling-stroke keeps lines crisp), dashed guides, dots/labels placed
// by CSS %. Attempts share one chronological x-axis; each quiz kind is its own
// line so you can read vocab and grammar progress separately.
const TREND_SERIES = [
  { kind: 'vocab', label: 'Vocab', line: 'text-moss', dot: 'bg-moss' },
  { kind: 'grammar', label: 'Grammar', line: 'text-ochre', dot: 'bg-ochre' },
];

function ScoreTrend({ attempts }) {
  const pts = useMemo(
    () =>
      [...attempts].sort((a, b) =>
        a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.sortOrder - b.sortOrder
      ),
    [attempts]
  );
  const n = pts.length;
  const height = 150;
  const X = (i) => (n <= 1 ? 50 : 4 + (i / (n - 1)) * 92);
  const Y = (p) => 88 - (p / 100) * 74; // 0% → 88, 100% → 14

  return (
    <div className="neu-inset rounded-2xl px-4 pb-3 pt-4">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-ink-faint">
          Scores over time
        </p>
        <div className="flex items-center gap-3">
          {TREND_SERIES.map((s) => (
            <span
              key={s.kind}
              className="flex items-center gap-1.5 text-[10px] font-semibold text-ink-soft"
            >
              <span className={`h-2 w-2 rounded-full ${s.dot}`} /> {s.label}
            </span>
          ))}
        </div>
      </div>

      <div aria-hidden>
        <div className="relative" style={{ height }}>
          {/* horizontal guides at 0 / 50 / 100% */}
          {[0, 50, 100].map((g) => (
            <div
              key={g}
              className={`pointer-events-none absolute inset-x-0 border-t ${
                g === 0 ? 'border-dashed border-ink-faint/40' : 'border-dotted border-ink-faint/25'
              }`}
              style={{ top: `${Y(g)}%` }}
            />
          ))}
          <span
            className="pointer-events-none absolute right-1 text-[8px] font-semibold text-ink-faint/70"
            style={{ top: `${Y(100)}%`, transform: 'translateY(-115%)' }}
          >
            100%
          </span>
          {/* dashed vertical at each attempt */}
          {pts.map((p, i) => (
            <div
              key={`v${i}`}
              className="pointer-events-none absolute inset-y-0 -translate-x-1/2 border-l border-dashed border-ink-faint/25"
              style={{ left: `${X(i)}%` }}
            />
          ))}
          {/* per-kind lines */}
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full">
            {TREND_SERIES.map((s) => {
              const seg = pts.map((p, i) => ({ p, i })).filter(({ p }) => p.kind === s.kind);
              if (seg.length < 2) return null;
              return (
                <polyline
                  key={s.kind}
                  points={seg.map(({ p, i }) => `${X(i)},${Y(attemptPct(p))}`).join(' ')}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2.6}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                  className={s.line}
                />
              );
            })}
          </svg>
          {/* dots + value labels (a dot per attempt, even single-point kinds) */}
          {pts.map((p, i) => {
            const s = TREND_SERIES.find((x) => x.kind === p.kind);
            const v = attemptPct(p);
            return (
              <span key={`d${i}`}>
                <span
                  className={`absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-cream ${
                    s?.dot || 'bg-ink-faint'
                  }`}
                  style={{ left: `${X(i)}%`, top: `${Y(v)}%` }}
                />
                <span
                  className="absolute -translate-x-1/2 text-[8px] font-bold tabular-nums text-ink"
                  style={{ left: `${X(i)}%`, top: `${Y(v)}%`, transform: 'translate(-50%, -135%)' }}
                >
                  {v}%
                </span>
              </span>
            );
          })}
        </div>
        {/* x labels: quiz title + date */}
        <div className="relative mt-2 h-7">
          {pts.map((p, i) => (
            <span
              key={`l${i}`}
              className="absolute flex -translate-x-1/2 flex-col items-center gap-0.5 text-center"
              style={{ left: `${X(i)}%` }}
            >
              <span className="whitespace-nowrap text-[9px] font-bold uppercase tracking-[0.08em] text-ink-soft">
                {shortTitle(p.title)}
              </span>
              <span className="whitespace-nowrap text-[8px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
                {fmtDate(p.createdAt)}
              </span>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Per-question breakdown ───────────────────────────────────────────────────
function StatPill({ label, score, total }) {
  const p = pct(score || 0, total);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-bold ${TONE_BG[toneFor(p)]}`}
    >
      <span className="uppercase tracking-[0.08em]">{label}</span>
      <span className="tabular-nums">
        {score ?? 0}/{total}
      </span>
    </span>
  );
}

function Flag({ label, ok }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.06em] ${
        ok ? 'bg-moss/[0.14] text-moss' : 'bg-ochre/[0.16] text-ochre'
      }`}
    >
      {ok ? <Check className="h-3 w-3" strokeWidth={3} /> : <X className="h-3 w-3" strokeWidth={3} />}
      {label}
    </span>
  );
}

function VocabReview({ ans }) {
  return (
    <div className="neu-inset rounded-xl px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-display text-[14px] font-semibold text-ink">{ans.word}</span>
        <div className="flex shrink-0 gap-1.5">
          <Flag label="Def" ok={ans.mainCorrect} />
          <Flag label="Conn" ok={ans.connCorrect} />
        </div>
      </div>
      {!ans.mainCorrect && (
        <p className="mt-1 text-[11px] leading-snug text-ink-soft">
          <span className="text-ink-faint">Match — you:</span> {ans.selectedLabel || '—'}{' '}
          <span className="text-ink-faint">· correct:</span> {ans.correctLabel}
        </p>
      )}
      {!ans.connCorrect && (
        <p className="mt-0.5 text-[11px] leading-snug text-ink-soft">
          <span className="text-ink-faint">Connotation — you:</span> {ans.selectedConnotation || '—'}{' '}
          <span className="text-ink-faint">· correct:</span> {ans.correctConnotation}
        </p>
      )}
    </div>
  );
}

function GrammarReview({ ans }) {
  return (
    <div className="neu-inset rounded-xl px-3 py-2.5">
      <div className="flex items-start justify-between gap-2">
        <span className="text-[13px] font-medium text-ink">{ans.title}</span>
        <span
          className={`mt-0.5 inline-flex shrink-0 items-center rounded-full p-0.5 ${
            ans.correct ? 'bg-moss/[0.14] text-moss' : 'bg-ochre/[0.16] text-ochre'
          }`}
        >
          {ans.correct ? (
            <Check className="h-3.5 w-3.5" strokeWidth={3} />
          ) : (
            <X className="h-3.5 w-3.5" strokeWidth={3} />
          )}
        </span>
      </div>
      {ans.detail && <p className="mt-1 text-[11px] text-ink-faint">{ans.detail}</p>}
      {!ans.correct && (
        <p className="mt-1 text-[11px] leading-snug text-ink-soft">
          <span className="text-ink-faint">you:</span> {ans.selectedLabel || '—'}{' '}
          <span className="text-ink-faint">· correct:</span> {ans.correctLabel}
        </p>
      )}
    </div>
  );
}

function AttemptCard({ attempt: a }) {
  return (
    <section className="neu-raised rounded-[1.5rem] p-5">
      <div className="mb-2.5 flex items-baseline justify-between gap-2">
        <h4 className="font-display text-[1.05rem] font-semibold text-ink">{a.title}</h4>
        <span className="shrink-0 text-[11px] font-medium text-ink-faint">{fmtDate(a.createdAt)}</span>
      </div>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {a.kind === 'vocab' ? (
          <>
            <StatPill label="Definitions" score={a.vocabScore} total={a.total} />
            <StatPill label="Connotation" score={a.connotationScore} total={a.total} />
          </>
        ) : (
          <StatPill label="Score" score={a.vocabScore} total={a.total} />
        )}
      </div>
      <div className="space-y-1.5">
        {a.kind === 'vocab'
          ? a.answers.map((ans, i) => <VocabReview key={i} ans={ans} />)
          : a.answers.map((ans, i) => <GrammarReview key={i} ans={ans} />)}
      </div>
    </section>
  );
}

// ── Detail view (its own URL: ?student=<slug>) ───────────────────────────────
function DetailView({ student, onBack }) {
  const ov = overall(student.attempts);
  const n = student.attempts.length;
  return (
    <div>
      <button
        onClick={onBack}
        className="neu-chip mb-5 inline-flex items-center gap-1.5 rounded-full py-2 pl-3 pr-4 text-[13px] font-semibold text-ink-soft transition active:scale-[0.97]"
      >
        <ArrowLeft className="h-4 w-4" strokeWidth={2.2} />
        All students
      </button>

      <section className="neu-raised mb-3 rounded-[1.75rem] p-5 sm:p-6">
        <div className="mb-4 flex items-center gap-4">
          <ScoreRing value={ov.pct} tone={toneFor(ov.pct)} />
          <div className="min-w-0">
            <h2 className="truncate font-display text-[1.6rem] font-semibold leading-tight text-ink">
              {student.name}
            </h2>
            <p className="mt-0.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
              {ov.correct}/{ov.possible} overall · {n} quiz{n === 1 ? '' : 'zes'}
            </p>
          </div>
        </div>
        {n >= 2 ? (
          <ScoreTrend attempts={student.attempts} />
        ) : (
          <p className="neu-inset rounded-2xl px-4 py-3 text-[12px] text-ink-soft">
            One quiz so far — the over-time trend appears once {student.name.split(' ')[0]} has taken
            at least two.
          </p>
        )}
      </section>

      <p className="mb-2.5 mt-6 px-1 text-[11px] font-bold uppercase tracking-[0.14em] text-ink-faint">
        Per-quiz breakdown
      </p>
      <div className="space-y-3">
        {[...student.attempts]
          .sort((a, b) => b.sortOrder - a.sortOrder)
          .map((a) => (
            <AttemptCard key={a.slug} attempt={a} />
          ))}
      </div>
    </div>
  );
}

// ── Tab ──────────────────────────────────────────────────────────────────────
export default function SatScoresTab() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const selected = searchParams.get('student');

  const [state, setState] = useState({ loading: true, error: null, students: [], quizzes: [] });

  useEffect(() => {
    let alive = true;
    fetch('/api/developer/satScores')
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (!alive) return;
        if (!ok || d?.error)
          setState({ loading: false, error: d?.error || 'Load failed', students: [], quizzes: [] });
        else
          setState({
            loading: false,
            error: null,
            students: d.students || [],
            quizzes: d.quizzes || [],
          });
      })
      .catch(() => alive && setState({ loading: false, error: 'Load failed', students: [], quizzes: [] }));
    return () => {
      alive = false;
    };
  }, []);

  // Best overall first; students with no attempts sink to the bottom (still
  // listed so gaps are visible), name as the tiebreak.
  const shown = useMemo(() => {
    const rank = (s) => (s.attempts.length ? overall(s.attempts).pct ?? -1 : -1);
    return [...state.students].sort((a, b) => rank(b) - rank(a) || a.name.localeCompare(b.name));
  }, [state.students]);

  // Resolve ?student=<slug> against the roster (full slug or bare first name).
  const selectedStudent = useMemo(() => {
    if (!selected) return null;
    const q = selected.toLowerCase();
    return (
      state.students.find((s) => studentSlug(s.name) === q) ||
      state.students.find((s) => studentSlug(s.name).split('-')[0] === q) ||
      null
    );
  }, [selected, state.students]);

  const goToStudent = (s) =>
    router.push(`/developer/sat?student=${encodeURIComponent(studentSlug(s.name))}`);
  const goBack = () => router.push('/developer/sat');

  // Detail route.
  if (selected) {
    if (state.loading) return <TabSkeleton rows={5} />;
    if (selectedStudent) return <DetailView student={selectedStudent} onBack={goBack} />;
    // Loaded but no match (bad slug / deactivated student).
    return (
      <div>
        <button
          onClick={goBack}
          className="neu-chip mb-5 inline-flex items-center gap-1.5 rounded-full py-2 pl-3 pr-4 text-[13px] font-semibold text-ink-soft transition active:scale-[0.97]"
        >
          <ArrowLeft className="h-4 w-4" strokeWidth={2.2} />
          All students
        </button>
        <EmptyNote>No active SAT student matches “{selected}”.</EmptyNote>
      </div>
    );
  }

  // Grid route.
  return (
    <div>
      <PageHeader eyebrow="Practice" title="SAT Scores">
        <p className="mt-2 max-w-xl text-[13px] leading-relaxed text-ink-soft">
          Every SAT student’s vocab and grammar results at a glance. Open a student to track their
          scores over time and see a full per-question breakdown.
        </p>
      </PageHeader>

      {state.loading ? (
        <TabSkeleton rows={6} />
      ) : state.error ? (
        <ErrorNote message={state.error} />
      ) : shown.length === 0 ? (
        <EmptyNote>No SAT students yet.</EmptyNote>
      ) : (
        <div className="space-y-2.5">
          {shown.map((s) => (
            <StudentScoreCard
              key={s.id}
              student={s}
              quizzes={state.quizzes}
              onOpen={() => goToStudent(s)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
