'use client';

import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, CircleAlert, Loader2, Plus, X } from 'lucide-react';

const SCORE_OPTIONS = [1, 2, 3, 4, 5];

function ScorePicker({ score, noExamTaken, onChange }) {
  return (
    <div className="mt-3 grid grid-cols-6 gap-1.5">
      {SCORE_OPTIONS.map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => onChange({ score: s, noExamTaken: false })}
          className={`rounded-xl py-2 text-sm font-bold transition active:scale-95 ${
            score === s && !noExamTaken
              ? 'bg-terracotta text-paper'
              : 'neu-chip text-ink-soft hover:text-ink'
          }`}
        >
          {s}
        </button>
      ))}
      <button
        type="button"
        onClick={() => onChange({ score: null, noExamTaken: true })}
        className={`rounded-xl py-2 text-[11px] font-bold transition active:scale-95 ${
          noExamTaken ? 'bg-terracotta text-paper' : 'neu-chip text-ink-soft hover:text-ink'
        }`}
      >
        N/A
      </button>
    </div>
  );
}

function ExamRow({ row, subjectOptions, usedNames, onChange, onRemove }) {
  return (
    <div className="neu-inset rounded-2xl p-4">
      <div className="flex items-start justify-between gap-3">
        {row.detected ? (
          <p className="min-w-0 flex-1 pt-1 text-[15px] font-medium text-ink">{row.examName}</p>
        ) : (
          <select
            value={row.examName}
            onChange={(e) =>
              onChange({ ...row, examName: e.target.value, score: null, noExamTaken: false })
            }
            className="min-w-0 flex-1 rounded-xl bg-transparent px-1 py-1.5 text-[15px] text-ink outline-none"
          >
            <option value="">Choose an exam…</option>
            {subjectOptions
              .filter((s) => s === row.examName || !usedNames.has(s.toLowerCase()))
              .map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
          </select>
        )}
        <button
          type="button"
          onClick={onRemove}
          className="shrink-0 rounded-full p-1.5 text-ink-faint transition hover:text-terracotta"
        >
          <X className="h-4 w-4" strokeWidth={2.2} />
        </button>
      </div>
      {(row.detected || row.examName) && (
        <ScorePicker
          score={row.score}
          noExamTaken={row.noExamTaken}
          onChange={({ score, noExamTaken }) => onChange({ ...row, score, noExamTaken })}
        />
      )}
    </div>
  );
}

export default function ApScoresCheckIn() {
  const [status, setStatus] = useState('loading'); // loading | error | done | form
  const [rows, setRows] = useState([]);
  const [subjectOptions, setSubjectOptions] = useState([]);
  const [doneEntries, setDoneEntries] = useState([]);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const keyRef = useRef(0);
  const nextKey = () => `row-${keyRef.current++}`;

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch('/api/apScores');
        const data = await res.json();
        if (!alive) return;
        if (data.error) throw new Error(data.error);
        if (data.submittedThisYear) {
          setDoneEntries(data.entries || []);
          setStatus('done');
          return;
        }
        setSubjectOptions(data.subjectOptions || []);
        setRows(
          (data.detectedCourses || []).map((c) => ({
            key: nextKey(),
            examName: c.name,
            score: null,
            noExamTaken: false,
            detected: true,
          }))
        );
        setStatus('form');
      } catch (e) {
        if (!alive) return;
        setError(e.message);
        setStatus('error');
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const usedNames = new Set(rows.map((r) => r.examName.toLowerCase()).filter(Boolean));

  function addRow() {
    setRows((r) => [
      ...r,
      { key: nextKey(), examName: '', score: null, noExamTaken: false, detected: false },
    ]);
  }
  function updateRow(key, next) {
    setRows((r) => r.map((row) => (row.key === key ? next : row)));
  }
  function removeRow(key) {
    setRows((r) => r.filter((row) => row.key !== key));
  }

  const canSubmit =
    !submitting && rows.every((r) => r.examName.trim() && (r.score != null || r.noExamTaken));

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const entries = rows.map((r) => ({
        examName: r.examName,
        score: r.score,
        noExamTaken: r.noExamTaken,
      }));
      const res = await fetch('/api/apScores', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries }),
      });
      const result = await res.json();
      if (!result.success) throw new Error(result.error || 'Submission failed');
      setDoneEntries(entries);
      setStatus('done');
    } catch (e) {
      setError(e.message);
      setSubmitting(false);
    }
  }

  if (status === 'loading') {
    return (
      <div className="portal-rise space-y-5">
        <div className="portal-skeleton h-3 w-32 rounded-full" />
        <div className="portal-skeleton h-10 w-56 rounded-2xl" />
        <div className="portal-skeleton h-64 rounded-3xl" />
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="portal-rise mt-8 rounded-3xl border border-terracotta/25 bg-clay-50 p-6 text-center">
        <CircleAlert className="mx-auto h-7 w-7 text-terracotta" strokeWidth={2} />
        <p className="mt-3 font-display text-lg font-semibold text-ink">Couldn’t load this</p>
        <p className="mt-1 text-sm text-ink-soft">{error}</p>
      </div>
    );
  }

  if (status === 'done') {
    return (
      <div className="portal-rise flex min-h-[55vh] flex-col items-center justify-center text-center">
        <span className="flex h-16 w-16 items-center justify-center rounded-3xl border border-moss/25 bg-moss/[0.08] text-moss shadow-card">
          <CheckCircle2 className="h-8 w-8" strokeWidth={1.9} />
        </span>
        <h1 className="mt-5 font-display text-2xl font-semibold tracking-tight text-ink">
          Reported for this year
        </h1>
        {doneEntries.length ? (
          <div className="mt-5 w-full max-w-xs space-y-2 text-left">
            {doneEntries.map((e, i) => (
              <div
                key={i}
                className="neu-chip flex items-center justify-between rounded-xl px-4 py-2.5"
              >
                <span className="text-sm text-ink">{e.examName}</span>
                <span className="text-sm font-bold text-ink-soft">
                  {e.noExamTaken ? 'N/A' : e.score}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-2 max-w-xs text-sm text-ink-soft">
            You reported no AP exams for this year.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="pb-2">
      <header className="portal-rise mb-6">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-faint">
          AP scores
        </p>
        <h1 className="mt-1 font-display text-[1.7rem] font-semibold leading-tight tracking-tight text-ink">
          Report your scores
        </h1>
      </header>

      {rows.length > 0 && (
        <p className="portal-rise mb-4 text-sm text-ink-soft">
          Pulled from your transcript — pick a score for each, or N/A if you took the class but not
          the exam.
        </p>
      )}

      <div className="portal-rise space-y-3">
        {rows.map((row) => (
          <ExamRow
            key={row.key}
            row={row}
            subjectOptions={subjectOptions}
            usedNames={usedNames}
            onChange={(next) => updateRow(row.key, next)}
            onRemove={() => removeRow(row.key)}
          />
        ))}
      </div>

      <button
        type="button"
        onClick={addRow}
        className="neu-chip portal-rise mt-3 flex w-full items-center justify-center gap-2 rounded-2xl py-3 text-sm font-semibold text-ink-soft transition active:scale-[0.99]"
      >
        <Plus className="h-4 w-4" strokeWidth={2.4} />
        Add a self-studied exam
      </button>

      {error && <p className="mt-4 text-sm font-medium text-terracotta-deep">{error}</p>}

      <button
        type="button"
        onClick={submit}
        disabled={!canSubmit}
        className="mt-6 flex w-full items-center justify-center gap-2 rounded-full bg-terracotta px-6 py-3.5 text-sm font-bold text-paper shadow-lift transition active:scale-[0.98] disabled:opacity-50"
      >
        {submitting ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2.4} />
            Submitting…
          </>
        ) : (
          'Submit'
        )}
      </button>
    </div>
  );
}
