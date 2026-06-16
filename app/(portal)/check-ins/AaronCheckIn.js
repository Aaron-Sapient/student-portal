'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  CalendarClock,
  ListTodo,
  MessageCircleQuestion,
  Send,
  CheckCircle2,
  CircleAlert,
  Loader2,
  Mail,
  ArrowLeft,
} from 'lucide-react';
import TaskTrough from './TaskTrough';

const CONCERN_OPTIONS = ['None', 'Quick Question', 'Need to Discuss'];
// value must match the backend's PREFERENCE_TO_DECISION map exactly; label is display-only.
const RESPONSE_OPTIONS = [
  { value: '15min', label: '15-min call' },
  { value: '30min', label: '30-min Zoom' },
  { value: 'Ready to finalize over email', label: 'Finalize over email' },
];

function mostRecentSaturday() {
  const now = new Date();
  const diff = (now.getDay() + 1) % 7;
  const sat = new Date(now);
  sat.setHours(0, 0, 0, 0);
  sat.setDate(now.getDate() - diff);
  return sat;
}
function stillValid(lastSubmitted) {
  if (!lastSubmitted) return false;
  return new Date(lastSubmitted) >= mostRecentSaturday();
}

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
        active
          ? 'bg-terracotta text-paper shadow-sm'
          : 'neu-chip text-ink-soft hover:text-ink'
      } ${className}`}
    >
      {children}
    </button>
  );
}

const fieldCls =
  'neu-inset w-full rounded-2xl px-4 py-3 text-[15px] text-ink outline-none transition placeholder:text-ink-faint focus:ring-2 focus:ring-terracotta/25';

export default function AaronCheckIn() {
  const router = useRouter();
  const [status, setStatus] = useState('loading'); // loading | error | done | needed | routed
  const [formData, setFormData] = useState(null);
  const [error, setError] = useState(null);
  const [routedReason, setRoutedReason] = useState('');

  const [step, setStep] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  const [deadlines, setDeadlines] = useState('');
  const [tasks, setTasks] = useState([
    { task: '', status: null },
    { task: '', status: null },
    { task: '', status: null },
  ]);
  const [concern, setConcern] = useState('None');
  const [concernText, setConcernText] = useState('');
  const [response, setResponse] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch('/api/getAaronUpdateFormData');
        const data = await res.json();
        if (!alive) return;
        if (data.error) throw new Error(data.error);
        if (stillValid(data.lastSubmitted)) {
          setStatus('done');
          return;
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
  }, []);

  const steps = ['deadlines', 'tasks', 'concerns', 'response'];
  const current = steps[step];
  const isFirst = step === 0;
  const isLast = step === steps.length - 1;

  async function submit() {
    if (submitting) return;
    if (!tasks.some((t) => t.task.trim())) {
      setError('Add at least one task before submitting.');
      return;
    }
    if (!response) {
      setError('Pick how you’d like to follow up.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const filled = tasks.filter((t) => t.task.trim());
      const res = await fetch('/api/submitAaronUpdateForm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          studentRowIndex: formData?.studentRowIndex,
          studentName: formData?.studentName,
          upcomingDeadlines: deadlines,
          taskUpdates: filled.map((t) => ({ task: t.task, status: t.status || 'Not Started' })),
          questionsCategory: concern,
          questionsText: concern !== 'None' ? concernText : '',
          responsePreference: response,
        }),
      });
      const result = await res.json();
      if (!result.success) throw new Error(result.error || 'Submission failed');
      if (result.decision === 'email') {
        setRoutedReason(result.reason || '');
        setStatus('routed');
      } else {
        router.push('/meetings/aaron');
      }
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
          Aaron has this week’s update. The next check-in opens Saturday.
        </p>
      </div>
    );
  }

  if (status === 'routed') {
    return (
      <div className="portal-rise flex min-h-[55vh] flex-col items-center justify-center text-center">
        <span className="neu-chip flex h-16 w-16 items-center justify-center rounded-3xl text-terracotta">
          <Mail className="h-8 w-8" strokeWidth={1.7} />
        </span>
        <h1 className="mt-5 font-display text-2xl font-semibold tracking-tight text-ink">
          You’re all set
        </h1>
        <p className="mt-2 max-w-xs text-sm text-ink-soft">
          Aaron will follow up with you over email this week — no meeting needed.
        </p>
        {routedReason && (
          <p className="mt-3 max-w-xs text-xs italic text-ink-faint">{routedReason}</p>
        )}
      </div>
    );
  }

  /* ── form ─────────────────────────────────────────────────────────────── */

  const progress = ((step + 1) / steps.length) * 100;

  return (
    <div className="pb-2">
      <div className="mb-6">
        <div className="flex items-baseline justify-between">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-faint">
            Aaron check-in
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

      <div
        key={current}
        className="portal-rise neu-raised rounded-3xl p-6 sm:p-7"
      >
        {current === 'deadlines' && (
          <>
            <StepHeader
              icon={CalendarClock}
              eyebrow="Comps & projects"
              title="Upcoming deadlines"
              blurb="List any deadlines for competitions or projects with Aaron — include dates."
            />
            <textarea
              value={deadlines}
              onChange={(e) => setDeadlines(e.target.value)}
              rows={5}
              placeholder="e.g. Science fair abstract due Fri · Research draft to Aaron next Wed"
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
              blurb="Add 1–3 tasks with Aaron and mark where each stands."
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
              eyebrow="For Aaron"
              title="Questions or concerns"
              blurb="Anything you want Aaron to know about your comps or projects?"
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

        {current === 'response' && (
          <>
            <StepHeader
              icon={Send}
              eyebrow="Follow-up"
              title="How do you want to follow up?"
              blurb="Pick the touchpoint that fits this week."
            />
            <div className="space-y-2">
              {RESPONSE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setResponse(opt.value)}
                  className={`flex w-full items-center justify-between rounded-2xl px-4 py-3.5 text-left text-[15px] font-medium transition active:scale-[0.99] ${
                    response === opt.value
                      ? 'border border-terracotta bg-terracotta/[0.07] text-ink'
                      : 'neu-chip text-ink-soft hover:text-ink'
                  }`}
                >
                  {opt.label}
                  <span
                    className={`flex h-5 w-5 items-center justify-center rounded-full border-2 ${
                      response === opt.value ? 'border-terracotta' : 'border-sand'
                    }`}
                  >
                    {response === opt.value && (
                      <span className="h-2.5 w-2.5 rounded-full bg-terracotta" />
                    )}
                  </span>
                </button>
              ))}
            </div>
          </>
        )}

        {error && <p className="mt-4 text-sm font-medium text-terracotta-deep">{error}</p>}
      </div>

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
              Analyzing…
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
