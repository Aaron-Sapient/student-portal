'use client';

// Senior essay-program weekly check-in. A COPY of RyanCheckIn (per Aaron — minimal
// overhead now, bespoke later): same steps/UI, but submitting does NOT trigger the
// Claude urgency eval / approval email / report — it just RECORDS the weekly
// check-in (Master AY timestamp), which is the deterministic prerequisite that
// unlocks senior booking for the week (see app/api/submitUpdateForm senior branch).

import { useEffect, useMemo, useState } from 'react';
import { DateTime } from 'luxon';
import {
  BookOpen,
  CalendarClock,
  ListTodo,
  MessageCircleQuestion,
  Sparkles,
  CheckCircle2,
  CircleAlert,
  Loader2,
  ArrowLeft,
} from 'lucide-react';
import { ZONE } from '../portalUtils';
import { usePortalData } from '../PortalDataContext';
import WeekFeel, { feelToRating } from './WeekFeel';
import TaskTrough from './TaskTrough';

const GRADE_OPTIONS = ['A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'D-', 'F'];
const CONCERN_OPTIONS = ['None', 'Quick Question', 'Need to Discuss'];

const semesterLabel = (s) => (s === 'S1' ? 'Fall' : 'Spring');

function isSummer() {
  const m = DateTime.now().setZone(ZONE).month;
  return m >= 6 && m <= 8;
}

/* ── small presentational atoms ─────────────────────────────────────────── */

function StepHeader({ icon: Icon, eyebrow, title, blurb }) {
  return (
    <div className="mb-6">
      <div className="flex items-center gap-3">
        <span className="neu-chip flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl text-terracotta">
          <Icon className="h-5 w-5" strokeWidth={1.9} />
        </span>
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-ink-faint">
            {eyebrow}
          </p>
          <h2 className="font-display text-[1.7rem] font-semibold leading-tight tracking-tight text-ink">
            {title}
          </h2>
        </div>
      </div>
      {blurb && <p className="mt-2 pl-[3.75rem] text-sm leading-relaxed text-ink-soft">{blurb}</p>}
    </div>
  );
}

function Segment({ active, onClick, children, className = '' }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full px-3 py-2.5 text-center text-[13px] font-semibold transition-all duration-150 active:scale-[0.97] ${
        active ? 'bg-terracotta text-paper shadow-sm' : 'neu-chip text-ink-soft hover:text-ink'
      } ${className}`}
    >
      {children}
    </button>
  );
}

const fieldCls =
  'neu-inset w-full rounded-2xl px-4 py-3 text-[15px] text-ink outline-none transition placeholder:text-ink-faint focus:ring-2 focus:ring-terracotta/25';

/* ── main ───────────────────────────────────────────────────────────────── */

export default function SeniorCheckIn() {
  const { data: portalData, loading: portalLoading, refreshHome } = usePortalData();
  const [status, setStatus] = useState('loading'); // loading | error | done | needed
  const [formData, setFormData] = useState(null);
  const [error, setError] = useState(null);

  const [step, setStep] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  // answers
  const [grades, setGrades] = useState({});
  const [openGrade, setOpenGrade] = useState(null);
  const [tests, setTests] = useState('');
  const [tasks, setTasks] = useState([
    { task: '', status: null },
    { task: '', status: null },
    { task: '', status: null },
  ]);
  const [concern, setConcern] = useState('None');
  const [concernText, setConcernText] = useState('');
  const [feel, setFeel] = useState(50);

  useEffect(() => {
    if (portalLoading) return;
    // "Have you checked in THIS Saturday-week?" — the weekly signal (raw AY vs the
    // current Saturday-week, LA-pinned server-side in home-data). NOT hasGrant: a
    // check-in grant is spendable across the current OR next Saturday-week, so keying
    // the form gate on the grant let a Saturday check-in block the FOLLOWING week's
    // check-in — even while the weekly reminder correctly nagged for it (Vaibhav
    // Gaddam, 7/17). Booking-unlock stays grant-based on the Meetings page
    // (senior.hasGrant); this gate is purely "do you owe this week's form". (The
    // reminder GAS uses a rolling-7-day window, not this Saturday-week — they agree
    // in the common case incl. this bug; late-week boundary diffs are benign.)
    if (portalData?.senior?.checkedInThisWeek) {
      setStatus('done');
      return;
    }
    let alive = true;
    (async () => {
      try {
        const res = await fetch('/api/getUpdateFormData');
        const data = await res.json();
        if (!alive) return;
        if (data.error) throw new Error(data.error);
        if (!data.skip && data.classes) {
          const g = {};
          data.classes.forEach((c, i) => (g[i] = c.grade || ''));
          setGrades(g);
        }
        setFormData(data);
        setStatus('needed');
      } catch (e) {
        if (!alive) return;
        setError(e.message);
        setStatus('error');
      }
    })();
    return () => {
      alive = false;
    };
  }, [portalLoading, portalData]);

  const showGrades =
    !!formData &&
    !formData.skip &&
    formData.semester !== 'NA' &&
    formData.gradeYear !== 'MS' &&
    Array.isArray(formData.classes) &&
    formData.classes.length > 0 &&
    !isSummer();

  const steps = useMemo(
    () => ['week', ...(showGrades ? ['grades'] : []), 'tests', 'tasks', 'concerns'],
    [showGrades]
  );
  const current = steps[step];
  const isFirst = step === 0;
  const isLast = step === steps.length - 1;

  async function submit() {
    if (submitting) return;
    if (!tasks.some((t) => t.task.trim())) {
      setError('Add at least one task before submitting.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const gradePayload = (formData?.classes || []).map((c, i) => ({
        rowOffset: c.rowOffset,
        grade: grades[i] || '',
      }));
      const filled = tasks.filter((t) => t.task.trim());
      const res = await fetch('/api/submitUpdateForm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          senior: true, // record-only: no Claude eval, no token, no email/report
          grades: gradePayload,
          classes: formData?.classes || [],
          studentSheetId: formData?.studentSheetId,
          gradesRange: formData?.gradesRange,
          studentRowIndex: formData?.studentRowIndex,
          studentName: formData?.studentName,
          testsAndDeadlines: tests,
          actionItemStatuses: filled.map((t) => ({ task: t.task, status: t.status || 'Not Started' })),
          questionsCategory: concern,
          questionsText: concern !== 'None' ? concernText : '',
          selfRating: feelToRating(feel),
        }),
      });
      const result = await res.json();
      if (!result.success) throw new Error(result.error || 'Submission failed');
      setStatus('done'); // recorded → booking is now unlocked for the week
      refreshHome(); // sync the shared cache so a nav-away-and-back doesn't re-show the form
    } catch (e) {
      setError(e.message);
      setSubmitting(false);
    }
  }

  function next() {
    setError(null);
    if (isLast) submit();
    else setStep((s) => s + 1);
  }
  function back() {
    setError(null);
    setStep((s) => Math.max(0, s - 1));
  }

  /* ── status screens ───────────────────────────────────────────────────── */

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
        <p className="mt-3 font-display text-lg font-semibold text-ink">Couldn’t load your check-in</p>
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
          You’re checked in
        </h1>
        <p className="mt-2 max-w-xs text-sm text-ink-soft">
          Your meetings are unlocked for the week — head to Meetings to book. The next check-in opens
          Saturday.
        </p>
      </div>
    );
  }

  /* ── form ─────────────────────────────────────────────────────────────── */

  const progress = ((step + 1) / steps.length) * 100;

  return (
    <div className="pb-2">
      {/* progress */}
      <div className="mb-6">
        <div className="flex items-baseline justify-between">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-faint">
            Weekly check-in
          </p>
          <p className="text-[11px] font-semibold tabular-nums text-ink-faint">
            {step + 1} / {steps.length}
          </p>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-sand/60">
          <div
            className="h-full rounded-full bg-terracotta transition-[width] duration-500 ease-out"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      {/* step card — keyed so each step re-animates */}
      <div key={current} className="portal-rise neu-raised relative overflow-hidden rounded-3xl p-6 sm:p-7">
        {current === 'week' && (
          <>
            <StepHeader
              icon={Sparkles}
              eyebrow="Self-evaluation"
              title="How’d the week go?"
              blurb="Slide the clay to where the week landed."
            />
            <WeekFeel value={feel} onChange={setFeel} />
          </>
        )}

        {current === 'grades' && (
          <>
            <StepHeader
              icon={BookOpen}
              eyebrow={`${formData.gradeYear} · ${semesterLabel(formData.semester)}`}
              title="Grades"
              blurb="Tap a class to set its current grade."
            />
            <div className="divide-y divide-sand/70">
              {formData.classes.map((cls, i) => (
                <div key={i} className="py-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="min-w-0 flex-1 truncate text-[15px] text-ink">{cls.name}</span>
                    <button
                      type="button"
                      onClick={() => setOpenGrade(openGrade === i ? null : i)}
                      className={`min-w-[3.25rem] rounded-full px-3.5 py-1.5 text-sm font-bold transition ${
                        openGrade === i
                          ? 'bg-terracotta text-paper'
                          : grades[i]
                          ? 'neu-chip text-ink'
                          : 'neu-chip text-ink-faint'
                      }`}
                    >
                      {grades[i] || '—'}
                    </button>
                  </div>
                  {openGrade === i && (
                    <div className="portal-rise mt-3 grid grid-cols-7 gap-1.5">
                      {GRADE_OPTIONS.map((g) => (
                        <button
                          key={g}
                          type="button"
                          onClick={() => {
                            setGrades((p) => ({ ...p, [i]: g }));
                            setOpenGrade(null);
                          }}
                          className={`rounded-lg py-2 text-sm font-semibold transition active:scale-95 ${
                            grades[i] === g
                              ? 'bg-terracotta text-paper'
                              : 'neu-chip text-ink-soft hover:text-ink'
                          }`}
                        >
                          {g}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </>
        )}

        {current === 'tests' && (
          <>
            <StepHeader
              icon={CalendarClock}
              eyebrow="This week & next"
              title="Tests & deadlines"
              blurb="List any tests, projects, or major assignments coming up — with dates."
            />
            <textarea
              value={tests}
              onChange={(e) => setTests(e.target.value)}
              rows={5}
              placeholder="e.g. Common App essay draft due Mon · UC PIQ #2 outline"
              className={`${fieldCls} resize-none leading-relaxed`}
            />
          </>
        )}

        {current === 'tasks' && (
          <>
            <StepHeader
              icon={ListTodo}
              eyebrow="Last week"
              title="Task updates"
              blurb="Add 1–3 tasks and mark where each stands."
            />
            <div className="space-y-4">
              {tasks.map((item, i) => (
                <div key={i} className="neu-inset rounded-2xl p-3">
                  <input
                    type="text"
                    value={item.task}
                    onChange={(e) =>
                      setTasks((p) => p.map((x, j) => (j === i ? { ...x, task: e.target.value } : x)))
                    }
                    placeholder={`Task ${i + 1}`}
                    className="w-full bg-transparent px-1 py-1 text-[15px] text-ink outline-none placeholder:text-ink-faint"
                  />
                  <div className="mt-2.5">
                    <TaskTrough
                      value={item.status}
                      onChange={(s) =>
                        setTasks((p) => p.map((x, j) => (j === i ? { ...x, status: s } : x)))
                      }
                    />
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {current === 'concerns' && (
          <>
            <StepHeader
              icon={MessageCircleQuestion}
              eyebrow="For your teacher"
              title="Questions or concerns"
              blurb="Anything you want your teacher to know about this week?"
            />
            <div className="grid grid-cols-3 gap-1.5">
              {CONCERN_OPTIONS.map((opt) => (
                <Segment
                  key={opt}
                  active={concern === opt}
                  onClick={() => {
                    setConcern(opt);
                    if (opt === 'None') setConcernText('');
                  }}
                  className="!text-[12px] !px-1"
                >
                  {opt}
                </Segment>
              ))}
            </div>
            {concern !== 'None' && (
              <textarea
                value={concernText}
                onChange={(e) => setConcernText(e.target.value)}
                rows={4}
                placeholder="Describe your question or concern…"
                className={`${fieldCls} mt-4 resize-none leading-relaxed`}
              />
            )}
          </>
        )}

        {error && <p className="mt-4 text-sm font-medium text-terracotta-deep">{error}</p>}
      </div>

      {/* nav */}
      <div className="mt-5 flex items-center gap-3">
        {!isFirst && (
          <button
            type="button"
            onClick={back}
            disabled={submitting}
            className="neu-chip flex items-center gap-1.5 rounded-full px-4 py-3 text-sm font-semibold text-ink-soft transition active:scale-[0.98] disabled:opacity-50"
          >
            <ArrowLeft className="h-4 w-4" strokeWidth={2.2} />
            Back
          </button>
        )}
        <button
          type="button"
          onClick={next}
          disabled={submitting}
          className="ml-auto flex items-center justify-center gap-2 rounded-full bg-terracotta px-6 py-3 text-sm font-bold text-paper shadow-lift transition active:scale-[0.98] disabled:opacity-60"
        >
          {submitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2.4} />
              Saving…
            </>
          ) : isLast ? (
            'Submit check-in'
          ) : (
            'Next'
          )}
        </button>
      </div>
    </div>
  );
}
