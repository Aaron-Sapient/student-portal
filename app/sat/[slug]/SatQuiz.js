'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');

// ── Small clay controls ──────────────────────────────────────────────────────
function Choice({ selected, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`flex w-full items-center gap-3 rounded-2xl px-4 py-3 text-left text-sm transition-all active:scale-[0.99] ${
        selected ? 'neu-raised font-semibold text-ink' : 'neu-chip text-ink-soft'
      }`}
    >
      <span
        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 ${
          selected ? 'border-terracotta' : 'border-ink-faint/50'
        }`}
      >
        {selected && <span className="h-2 w-2 rounded-full bg-terracotta" />}
      </span>
      <span className="min-w-0 flex-1">{children}</span>
    </button>
  );
}

function PrimaryButton({ disabled, onClick, children }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="inline-flex w-full items-center justify-center rounded-full bg-gradient-to-br from-terracotta-soft to-terracotta px-6 py-3.5 font-display text-base font-semibold text-paper shadow-lift transition-transform active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-45 disabled:active:scale-100"
    >
      {children}
    </button>
  );
}

function ScoreCard({ label, score, total }) {
  return (
    <div className="neu-raised rounded-3xl p-5 text-center">
      <p className="font-display text-4xl font-semibold leading-none text-ink">
        {score}
        <span className="text-2xl text-ink-faint">/{total}</span>
      </p>
      <p className="mt-2 text-[11px] font-bold uppercase tracking-[0.12em] text-terracotta">
        {label}
      </p>
    </div>
  );
}

// ── Screens ──────────────────────────────────────────────────────────────────
function Notice({ children }) {
  return (
    <div className="portal-rise neu-inset rounded-3xl p-6 text-center text-sm text-ink-soft">
      {children}
    </div>
  );
}

function Results({ title, result, alreadyTaken }) {
  return (
    <div>
      <header className="portal-rise mb-6">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-terracotta">{title}</p>
        <h1 className="mt-1 font-display text-3xl font-semibold text-ink">Your results</h1>
        {alreadyTaken && (
          <p className="mt-2 text-sm text-ink-soft">
            You&apos;ve already completed this quiz — here&apos;s how you did.
          </p>
        )}
      </header>

      <div className="portal-rise mb-7 grid grid-cols-2 gap-4" style={{ animationDelay: '60ms' }}>
        <ScoreCard label="Vocabulary" score={result.vocab_score} total={result.total} />
        <ScoreCard label="Connotation" score={result.connotation_score} total={result.total} />
      </div>

      <h2 className="portal-rise mb-3 text-[11px] font-bold uppercase tracking-[0.14em] text-ink-faint" style={{ animationDelay: '110ms' }}>
        Review
      </h2>
      <div className="space-y-3">
        {(result.answers || []).map((r, i) => (
          <div
            key={r.target || i}
            className="portal-rise neu-chip rounded-3xl p-4"
            style={{ animationDelay: `${150 + i * 50}ms` }}
          >
            <p className="font-display text-lg font-semibold text-ink">{r.word}</p>
            <div className="mt-2 text-sm">
              <p className={r.mainCorrect ? 'text-moss' : 'text-terracotta-deep'}>
                {r.mainCorrect ? '✓' : '✗'} Your answer: {r.selectedLabel || '—'}
              </p>
              {!r.mainCorrect && (
                <p className="text-ink-soft">Correct: {r.correctLabel}</p>
              )}
            </div>
            <div className="mt-1.5 text-sm">
              <p className={r.connCorrect ? 'text-moss' : 'text-terracotta-deep'}>
                {r.connCorrect ? '✓' : '✗'} Connotation: {cap(r.selectedConnotation) || '—'}
              </p>
              {!r.connCorrect && (
                <p className="text-ink-soft">Correct: {cap(r.correctConnotation)}</p>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-8 text-center">
        <Link href="/sat" className="text-sm font-semibold text-terracotta-deep">
          ← Back to all quizzes
        </Link>
      </div>
    </div>
  );
}

function GrammarResults({ title, result, alreadyTaken }) {
  return (
    <div>
      <header className="portal-rise mb-6">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-terracotta">{title}</p>
        <h1 className="mt-1 font-display text-3xl font-semibold text-ink">Your results</h1>
        {alreadyTaken && (
          <p className="mt-2 text-sm text-ink-soft">
            You&apos;ve already completed this quiz — here&apos;s how you did.
          </p>
        )}
      </header>

      <div className="portal-rise mb-7" style={{ animationDelay: '60ms' }}>
        <ScoreCard label="Grammar" score={result.vocab_score} total={result.total} />
      </div>

      <h2 className="portal-rise mb-3 text-[11px] font-bold uppercase tracking-[0.14em] text-ink-faint" style={{ animationDelay: '110ms' }}>
        Review
      </h2>
      <div className="space-y-3">
        {(result.answers || []).map((r, i) => (
          <div
            key={r.id || i}
            className="portal-rise neu-chip rounded-3xl p-4"
            style={{ animationDelay: `${150 + i * 50}ms` }}
          >
            <p className="font-display text-base font-semibold leading-snug text-ink">{r.title}</p>
            {r.detail && <p className="mt-1 text-xs text-ink-faint">{r.detail}</p>}
            {r.type === 'first_noun' ? (
              <div className="mt-2 space-y-1.5 text-sm">
                {(r.parts || []).map((p) => (
                  <p key={p.id} className={p.ok ? 'text-moss' : 'text-terracotta-deep'}>
                    {p.ok ? '✓' : '✗'} {p.sentence} — you picked &ldquo;{p.selected || '—'}&rdquo;
                    {!p.ok && <span className="text-ink-soft"> (correct: &ldquo;{p.correct}&rdquo;)</span>}
                  </p>
                ))}
              </div>
            ) : (
              <div className="mt-2 text-sm">
                <p className={r.correct ? 'text-moss' : 'text-terracotta-deep'}>
                  {r.correct ? '✓' : '✗'} Your answer: {r.selectedLabel || '—'}
                </p>
                {!r.correct && <p className="text-ink-soft">Correct: {r.correctLabel}</p>}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="mt-8 text-center">
        <Link href="/sat" className="text-sm font-semibold text-terracotta-deep">
          ← Back to all quizzes
        </Link>
      </div>
    </div>
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────
const needsConn = (q) => Array.isArray(q.connotationOptions) && q.connotationOptions.length > 0;

export default function SatQuiz({ slug }) {
  const [status, setStatus] = useState('loading'); // loading | pick | taking | done | error
  const [students, setStudents] = useState([]);
  const [title, setTitle] = useState('Quiz');
  const [kind, setKind] = useState('vocab');
  const [studentId, setStudentId] = useState('');
  const [questions, setQuestions] = useState([]);
  const [answers, setAnswers] = useState({}); // { [qid]: { selectedKey, selectedConnotation } }
  const [result, setResult] = useState(null);
  const [alreadyTaken, setAlreadyTaken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Roster + this quiz's title.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/sat/init');
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) throw new Error(data.error || 'Failed to load');
        setStudents(data.students || []);
        const q = (data.quizzes || []).find((x) => x.slug === slug);
        if (q) {
          setTitle(q.title);
          if (q.kind) setKind(q.kind);
        }
        setStatus('pick');
      } catch (err) {
        if (!cancelled) {
          setError(err.message || 'Something went wrong.');
          setStatus('error');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const startQuiz = useCallback(async () => {
    if (!studentId) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch(
        `/api/sat/quiz?slug=${encodeURIComponent(slug)}&studentId=${encodeURIComponent(studentId)}`
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load the quiz');
      if (data.alreadyTaken) {
        setResult(data.result);
        setAlreadyTaken(true);
        setStatus('done');
        return;
      }
      if (data.kind) setKind(data.kind);
      setQuestions(data.questions || []);
      setAnswers({});
      setStatus('taking');
    } catch (err) {
      setError(err.message || 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }, [slug, studentId]);

  const setMain = (qid, key) =>
    setAnswers((a) => ({ ...a, [qid]: { ...a[qid], selectedKey: key } }));
  const setConn = (qid, c) =>
    setAnswers((a) => ({ ...a, [qid]: { ...a[qid], selectedConnotation: c } }));
  const setPart = (qid, partId, word) =>
    setAnswers((a) => ({
      ...a,
      [qid]: { ...a[qid], parts: { ...(a[qid]?.parts || {}), [partId]: word } },
    }));

  const isQuestionComplete = (q) => {
    if (q.type === 'first_noun') {
      const parts = answers[q.id]?.parts || {};
      return (q.parts || []).every((p) => !!parts[p.id]);
    }
    return !!answers[q.id]?.selectedKey && (!needsConn(q) || !!answers[q.id]?.selectedConnotation);
  };

  const complete = questions.length > 0 && questions.every(isQuestionComplete);

  const submit = useCallback(async () => {
    if (!complete) return;
    setBusy(true);
    setError('');
    try {
      const responses = questions.map((q) => ({
        target: q.target,
        type: q.type,
        selectedKey: answers[q.id]?.selectedKey,
        selectedConnotation: answers[q.id]?.selectedConnotation,
        parts: q.type === 'first_noun' ? answers[q.id]?.parts || {} : undefined,
      }));
      const res = await fetch('/api/sat/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentId, slug, responses }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to submit');
      setResult(data.result);
      setAlreadyTaken(!!data.alreadyTaken);
      setStatus('done');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      setError(err.message || 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }, [complete, questions, answers, studentId, slug]);

  // ── Render ──
  if (status === 'loading') {
    return <Notice>Loading…</Notice>;
  }

  if (status === 'error') {
    return (
      <div>
        <Notice>{error || 'Something went wrong.'}</Notice>
        <div className="mt-6 text-center">
          <Link href="/sat" className="text-sm font-semibold text-terracotta-deep">
            ← Back to all quizzes
          </Link>
        </div>
      </div>
    );
  }

  if (status === 'done' && result) {
    return (result.kind || kind) === 'grammar' ? (
      <GrammarResults title={title} result={result} alreadyTaken={alreadyTaken} />
    ) : (
      <Results title={title} result={result} alreadyTaken={alreadyTaken} />
    );
  }

  if (status === 'pick') {
    return (
      <div>
        <header className="portal-rise mb-6">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-terracotta">{title}</p>
          <h1 className="mt-1 font-display text-3xl font-semibold text-ink">Choose your name</h1>
        </header>

        <div className="portal-rise neu-raised rounded-[2rem] p-6" style={{ animationDelay: '60ms' }}>
          <label
            htmlFor="sat-name"
            className="text-[11px] font-bold uppercase tracking-[0.12em] text-ink-faint"
          >
            Your name
          </label>
          <div className="neu-inset mt-2 rounded-2xl px-1">
            <select
              id="sat-name"
              value={studentId}
              onChange={(e) => setStudentId(e.target.value)}
              className="w-full bg-transparent px-3 py-3.5 text-base text-ink outline-none"
            >
              <option value="">Select your name…</option>
              {students.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>

          <div className="mt-5">
            <PrimaryButton disabled={!studentId || busy} onClick={startQuiz}>
              {busy ? 'Loading…' : 'Start quiz'}
            </PrimaryButton>
          </div>
          {error && <p className="mt-3 text-center text-sm text-terracotta-deep">{error}</p>}
        </div>

        <div className="mt-6 text-center">
          <Link href="/sat" className="text-sm font-semibold text-terracotta-deep">
            ← All quizzes
          </Link>
        </div>
      </div>
    );
  }

  // status === 'taking'
  return (
    <div>
      <header className="portal-rise mb-6">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-terracotta">{title}</p>
        <h1 className="mt-1 font-display text-3xl font-semibold text-ink">
          Answer all {questions.length}
        </h1>
        <p className="mt-2 text-sm text-ink-soft">
          {kind === 'grammar' ? (
            'Pick the best answer for each question.'
          ) : (
            <>
              For each, choose the answer <em>and</em> its connotation.
            </>
          )}
        </p>
      </header>

      <div className="space-y-4">
        {questions.map((q, i) => {
          const a = answers[q.id] || {};
          return (
            <div
              key={q.id}
              className="portal-rise neu-raised rounded-[2rem] p-5"
              style={{ animationDelay: `${i * 55}ms` }}
            >
              <div className="mb-3 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-terracotta">
                    {q.promptLabel}
                  </span>
                  {q.badge && (
                    <span className="rounded-full bg-terracotta/15 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide text-terracotta-deep">
                      {q.badge}
                    </span>
                  )}
                </div>
                <span className="text-[10px] font-semibold text-ink-faint">
                  {i + 1} / {questions.length}
                </span>
              </div>
              <p className="mb-4 font-display text-xl font-semibold leading-snug text-ink">
                {q.prompt}
              </p>

              {q.type === 'identify' && (
                <div className="mb-4 space-y-1 rounded-2xl border border-ink-faint/20 p-3 text-sm text-ink-soft">
                  {q.choices.map((c, ci) => (
                    <p key={ci}>{c}</p>
                  ))}
                </div>
              )}

              {q.type === 'first_noun' ? (
                <div className="space-y-3">
                  {q.parts.map((p) => (
                    <div
                      key={p.id}
                      className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <p className="flex-1 text-sm text-ink">{p.sentence}</p>
                      <div className="neu-inset shrink-0 rounded-2xl px-1 sm:w-40">
                        <select
                          value={a.parts?.[p.id] || ''}
                          onChange={(e) => setPart(q.id, p.id, e.target.value)}
                          className="w-full bg-transparent px-3 py-2.5 text-sm text-ink outline-none"
                        >
                          <option value="">Select…</option>
                          {p.options.map((w, wi) => (
                            <option key={wi} value={w}>
                              {w}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  ))}
                </div>
              ) : q.type === 'identify' ? (
                <div className="neu-inset rounded-2xl px-1">
                  <select
                    value={a.selectedKey || ''}
                    onChange={(e) => setMain(q.id, e.target.value)}
                    className="w-full bg-transparent px-3 py-3 text-sm text-ink outline-none"
                  >
                    <option value="">Select…</option>
                    {q.options.map((o) => (
                      <option key={o.key} value={o.key}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <div className="space-y-2">
                  {q.options.map((o) => (
                    <Choice
                      key={o.key}
                      selected={a.selectedKey === o.key}
                      onClick={() => setMain(q.id, o.key)}
                    >
                      {o.label}
                    </Choice>
                  ))}
                </div>
              )}

              {needsConn(q) && (
                <div className="mt-4">
                  <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.12em] text-ink-faint">
                    Connotation
                  </p>
                  <div className="grid grid-cols-3 gap-2">
                    {q.connotationOptions.map((c) => {
                      const sel = a.selectedConnotation === c;
                      return (
                        <button
                          key={c}
                          type="button"
                          aria-pressed={sel}
                          onClick={() => setConn(q.id, c)}
                          className={`rounded-full px-3 py-2 text-xs font-semibold transition-all active:scale-95 ${
                            sel ? 'neu-raised text-terracotta-deep' : 'neu-chip text-ink-faint'
                          }`}
                        >
                          {cap(c)}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="sticky bottom-4 mt-7">
        <div className="neu-raised rounded-full p-1.5">
          <PrimaryButton disabled={!complete || busy} onClick={submit}>
            {busy ? 'Submitting…' : complete ? 'Submit quiz' : 'Answer every question to submit'}
          </PrimaryButton>
        </div>
        {error && <p className="mt-3 text-center text-sm text-terracotta-deep">{error}</p>}
      </div>
    </div>
  );
}
