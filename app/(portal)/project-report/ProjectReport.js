'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, CircleAlert, Loader2, Mail, PencilLine } from 'lucide-react';
import { setNoProjectFlag } from '../noProjectFlag';

// Where "email Ryan to finalize" goes: To = his main inbox, CC = his portal address.
const RYAN_EMAIL = 'ryan@sapientacademy.com';
const RYAN_CC = 'ryan@admissions.partners';

const EMPTY = { projectName: '', projectPlan: '', teamMembers: '', timeline: '', preferredTime: '' };

const inputCls =
  'neu-inset w-full rounded-2xl bg-transparent px-4 py-3 text-[15px] text-ink outline-none placeholder:text-ink-faint';
const taCls = `${inputCls} min-h-[92px] resize-y leading-relaxed`;
const primaryBtn =
  'flex w-full items-center justify-center gap-2 rounded-full bg-terracotta px-6 py-3.5 text-sm font-bold text-paper shadow-lift transition active:scale-[0.98] disabled:opacity-50';
const chipBtn =
  'neu-chip flex w-full items-center justify-center gap-2 rounded-2xl py-3.5 text-sm font-semibold text-ink-soft transition active:scale-[0.99]';

function Field({ label, hint, children }) {
  return (
    <label className="portal-rise block">
      <span className="text-sm font-semibold text-ink">{label}</span>
      {hint && <span className="mt-0.5 block text-xs text-ink-soft">{hint}</span>}
      <div className="mt-2">{children}</div>
    </label>
  );
}

function Header() {
  return (
    <header className="portal-rise mb-6">
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-faint">
        Group project
      </p>
      <h1 className="mt-1 font-display text-[1.7rem] font-semibold leading-tight tracking-tight text-ink">
        Report your project
      </h1>
    </header>
  );
}

export default function ProjectReport() {
  const [status, setStatus] = useState('loading'); // loading|error|gate|form|notFinalized|noProject|done
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch('/api/submitProjectReport');
        const data = await res.json();
        if (!alive) return;
        if (data.error) throw new Error(data.error);
        const r = data.report;
        if (data.submitted && r) {
          setForm({
            projectName: r.projectName || '',
            projectPlan: r.projectPlan || '',
            teamMembers: r.teamMembers || '',
            timeline: r.timeline || '',
            preferredTime: r.preferredTime || '',
          });
          setNoProjectFlag(r.response);
          setStatus(
            r.response === 'finalized'
              ? 'done'
              : r.response === 'no_project'
                ? 'noProject'
                : 'notFinalized'
          );
          return;
        }
        setNoProjectFlag(null);
        setStatus('gate');
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

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const canSubmit =
    !submitting &&
    form.projectName.trim() &&
    form.projectPlan.trim() &&
    form.teamMembers.trim() &&
    form.timeline.trim();

  async function post(payload, nextStatus) {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/submitProjectReport', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const result = await res.json();
      if (!result.success) throw new Error(result.error || 'Submission failed');
      setNoProjectFlag(payload.response);
      setStatus(nextStatus);
    } catch (e) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  }

  function submitReport() {
    if (!canSubmit) return;
    post({ response: 'finalized', ...form }, 'done');
  }

  // ── loading / error ────────────────────────────────────────────────────────
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

  // ── gate ───────────────────────────────────────────────────────────────────
  if (status === 'gate') {
    return (
      <div className="pb-2">
        <Header />
        <p className="portal-rise mb-5 text-sm text-ink-soft">
          Ryan wants a quick update on everyone’s group project. Submit yours and he’ll send a link
          to book a 15-minute check-in.
        </p>
        <div className="neu-inset portal-rise rounded-3xl p-5">
          <p className="text-[15px] font-semibold text-ink">
            Are you on a group project this summer?
          </p>
          <div className="mt-4 space-y-2.5">
            <button type="button" onClick={() => setStatus('form')} className={primaryBtn}>
              Yes — our team is set
            </button>
            <button
              type="button"
              disabled={submitting}
              onClick={() => post({ response: 'not_finalized' }, 'notFinalized')}
              className={chipBtn}
            >
              Yes — but the roster isn’t final
            </button>
            <button
              type="button"
              disabled={submitting}
              onClick={() => post({ response: 'no_project' }, 'noProject')}
              className={chipBtn}
            >
              No — I’m not on a group project
            </button>
          </div>
          {error && <p className="mt-4 text-sm font-medium text-terracotta-deep">{error}</p>}
        </div>
      </div>
    );
  }

  // ── roster not finalized → email Ryan ──────────────────────────────────────
  if (status === 'notFinalized') {
    const subject = encodeURIComponent('Group project — finalizing our roster');
    const bodyText = encodeURIComponent(
      "Hi Ryan,\n\nOur group project team isn't finalized yet. Can you help us lock in the roster so we can start booking our weekly meetings?\n\nThanks!"
    );
    return (
      <div className="portal-rise flex min-h-[55vh] flex-col items-center justify-center text-center">
        <span className="flex h-16 w-16 items-center justify-center rounded-3xl border border-ochre/25 bg-ochre/[0.08] text-ochre shadow-card">
          <Mail className="h-8 w-8" strokeWidth={1.8} />
        </span>
        <h1 className="mt-5 font-display text-2xl font-semibold tracking-tight text-ink">
          Email Ryan to finalize
        </h1>
        <p className="mt-2 max-w-xs text-sm text-ink-soft">
          Your team isn’t finalized yet. Email Ryan directly and he’ll help you lock in your roster
          so you can start booking your weekly meetings.
        </p>
        <div className="mt-6 w-full max-w-xs space-y-2.5">
          <a
            href={`mailto:${RYAN_EMAIL}?cc=${RYAN_CC}&subject=${subject}&body=${bodyText}`}
            className={primaryBtn}
          >
            <Mail className="h-4 w-4" strokeWidth={2.2} />
            Email Ryan
          </a>
          <button type="button" onClick={() => setStatus('form')} className={chipBtn}>
            Our team is finalized now
          </button>
        </div>
      </div>
    );
  }

  // ── not on a project ───────────────────────────────────────────────────────
  if (status === 'noProject') {
    return (
      <div className="portal-rise flex min-h-[55vh] flex-col items-center justify-center text-center">
        <span className="flex h-16 w-16 items-center justify-center rounded-3xl border border-moss/25 bg-moss/[0.08] text-moss shadow-card">
          <CheckCircle2 className="h-8 w-8" strokeWidth={1.9} />
        </span>
        <h1 className="mt-5 font-display text-2xl font-semibold tracking-tight text-ink">
          All set
        </h1>
        <p className="mt-2 max-w-xs text-sm text-ink-soft">
          Thanks for letting us know — nothing else to do here.
        </p>
        <button
          type="button"
          onClick={() => {
            setNoProjectFlag(null);
            setStatus('gate');
          }}
          className="mt-6 text-sm font-semibold text-ink-soft underline underline-offset-4 transition hover:text-ink"
        >
          Actually, I am on a group project
        </button>
      </div>
    );
  }

  // ── done (finalized report submitted) ──────────────────────────────────────
  if (status === 'done') {
    const rows = [
      ['Project', form.projectName],
      ['Team', form.teamMembers],
      ['Timeline', form.timeline],
      ['Preferred time', form.preferredTime],
    ].filter(([, v]) => v && v.trim());
    return (
      <div className="portal-rise flex min-h-[55vh] flex-col items-center justify-center text-center">
        <span className="flex h-16 w-16 items-center justify-center rounded-3xl border border-moss/25 bg-moss/[0.08] text-moss shadow-card">
          <CheckCircle2 className="h-8 w-8" strokeWidth={1.9} />
        </span>
        <h1 className="mt-5 font-display text-2xl font-semibold tracking-tight text-ink">
          Report submitted
        </h1>
        <p className="mt-2 max-w-xs text-sm text-ink-soft">
          Thanks! Ryan will send your booking link shortly so you can grab a 15-minute slot.
        </p>
        {rows.length > 0 && (
          <div className="mt-5 w-full max-w-xs space-y-2 text-left">
            {rows.map(([label, value]) => (
              <div key={label} className="neu-chip rounded-xl px-4 py-2.5">
                <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
                  {label}
                </p>
                <p className="mt-0.5 whitespace-pre-line text-sm text-ink">{value}</p>
              </div>
            ))}
          </div>
        )}
        <button
          type="button"
          onClick={() => setStatus('form')}
          className="mt-6 inline-flex items-center gap-1.5 text-sm font-semibold text-ink-soft transition hover:text-ink"
        >
          <PencilLine className="h-4 w-4" strokeWidth={2.2} />
          Edit my report
        </button>
      </div>
    );
  }

  // ── form (finalized report) ────────────────────────────────────────────────
  return (
    <div className="pb-2">
      <Header />
      <p className="portal-rise mb-5 text-sm text-ink-soft">
        Give Ryan the essentials — free-form is fine, just be specific.
      </p>

      <div className="space-y-4">
        <Field label="Project name">
          <input
            className={inputCls}
            value={form.projectName}
            onChange={set('projectName')}
            placeholder="What’s your project called?"
          />
        </Field>
        <Field label="Project plan" hint="What are you building or researching, and toward what?">
          <textarea className={taCls} value={form.projectPlan} onChange={set('projectPlan')} />
        </Field>
        <Field label="Confirmed team members" hint="Full names of everyone officially on the team.">
          <textarea className={taCls} value={form.teamMembers} onChange={set('teamMembers')} />
        </Field>
        <Field label="Timeline & deadlines" hint="Key milestones and target dates.">
          <textarea className={taCls} value={form.timeline} onChange={set('timeline')} />
        </Field>
        <Field label="Preferred meeting time" hint="Optional — when works best for your check-in?">
          <input
            className={inputCls}
            value={form.preferredTime}
            onChange={set('preferredTime')}
            placeholder="e.g. Saturday evening, or weekday afternoons"
          />
        </Field>
      </div>

      {error && <p className="mt-4 text-sm font-medium text-terracotta-deep">{error}</p>}

      <button type="button" onClick={submitReport} disabled={!canSubmit} className={`${primaryBtn} mt-6`}>
        {submitting ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2.4} />
            Submitting…
          </>
        ) : (
          'Submit report'
        )}
      </button>
    </div>
  );
}
