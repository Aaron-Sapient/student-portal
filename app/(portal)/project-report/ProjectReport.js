'use client';

import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, CircleAlert, Loader2, Mail, PencilLine, Plus, X } from 'lucide-react';
import { setNoProjectFlag } from '../noProjectFlag';

// Where "email Ryan to finalize" goes: To = his main inbox, CC = his portal address.
const RYAN_EMAIL = 'ryan@sapientacademy.com';
const RYAN_CC = 'ryan@admissions.partners';
const RYAN_MAILTO = `mailto:${RYAN_EMAIL}?cc=${RYAN_CC}&subject=${encodeURIComponent(
  'Group project — finalizing our roster'
)}&body=${encodeURIComponent(
  "Hi Ryan,\n\nOur group project team isn't finalized yet. Can you help us lock in the roster so we can start booking our weekly meetings?\n\nThanks!"
)}`;

const emptyProject = () => ({
  name: '',
  plan: '',
  teamMembers: '',
  timeline: '',
  preferredTime: '',
  notFinalized: false,
});

const inputCls =
  'neu-inset w-full rounded-2xl bg-transparent px-4 py-3 text-[15px] text-ink outline-none placeholder:text-ink-faint';
const taCls = `${inputCls} min-h-[84px] resize-y leading-relaxed`;
const primaryBtn =
  'flex w-full items-center justify-center gap-2 rounded-full bg-terracotta px-6 py-3.5 text-sm font-bold text-paper shadow-lift transition active:scale-[0.98] disabled:opacity-50';
const chipBtn =
  'neu-chip flex w-full items-center justify-center gap-2 rounded-2xl py-3.5 text-sm font-semibold text-ink-soft transition active:scale-[0.99]';

function Field({ label, hint, children }) {
  return (
    <label className="block">
      <span className="text-sm font-semibold text-ink">{label}</span>
      {hint && <span className="mt-0.5 block text-xs text-ink-soft">{hint}</span>}
      <div className="mt-2">{children}</div>
    </label>
  );
}

function Header({ sub }) {
  return (
    <header className="portal-rise mb-5">
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-faint">
        Group project
      </p>
      <h1 className="mt-1 font-display text-[1.7rem] font-semibold leading-tight tracking-tight text-ink">
        Report your project{sub ? 's' : ''}
      </h1>
    </header>
  );
}

function ProjectCard({ index, project, canRemove, onChange, onRemove }) {
  const set = (k) => (e) => onChange({ ...project, [k]: e.target.value });
  const nf = project.notFinalized;
  return (
    <div className="portal-rise neu-raised rounded-3xl p-5">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
          Project {index + 1}
        </p>
        {canRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="rounded-full p-1.5 text-ink-faint transition hover:text-terracotta"
            aria-label={`Remove project ${index + 1}`}
          >
            <X className="h-4 w-4" strokeWidth={2.2} />
          </button>
        )}
      </div>

      <div className="space-y-4">
        <Field label="Project name">
          <input className={inputCls} value={project.name} onChange={set('name')} placeholder="What's it called?" />
        </Field>

        {/* Asked FIRST, before the detail fields: a student with an unfinalized
            roster picks the email-Ryan path up front instead of filling in work
            that then collapses when they flag it. */}
        <div className={`rounded-2xl p-3.5 ${nf ? 'neu-inset bg-ochre/[0.07]' : 'neu-inset'}`}>
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={nf}
              onChange={(e) => onChange({ ...project, notFinalized: e.target.checked })}
              className="mt-0.5 h-4 w-4 shrink-0 accent-terracotta"
            />
            <span className="text-sm text-ink-soft">
              <span className="font-semibold text-ink">Our roster isn’t finalized yet.</span>
              {nf ? (
                <>
                  {' '}No need to fill anything else —{' '}
                  <a href={RYAN_MAILTO} className="font-semibold text-terracotta-deep underline underline-offset-2">
                    email Ryan
                  </a>{' '}
                  to lock in your team, then come back to report the rest.
                </>
              ) : (
                <>{' '}Check this to skip the details and just flag it to Ryan.</>
              )}
            </span>
          </label>
        </div>

        {!nf && (
          <>
            <Field label="Project plan" hint="What are you building or researching, and toward what?">
              <textarea className={taCls} value={project.plan} onChange={set('plan')} />
            </Field>
            <Field label="Confirmed team members" hint="Full names of everyone officially on the team.">
              <textarea className={taCls} value={project.teamMembers} onChange={set('teamMembers')} />
            </Field>
            <Field label="Timeline & deadlines" hint="Key milestones and target dates.">
              <textarea className={taCls} value={project.timeline} onChange={set('timeline')} />
            </Field>
            <Field label="Preferred meeting time" hint="Optional — when works best?">
              <input
                className={inputCls}
                value={project.preferredTime}
                onChange={set('preferredTime')}
                placeholder="e.g. Saturday evening, or weekday afternoons"
              />
            </Field>
          </>
        )}
      </div>
    </div>
  );
}

export default function ProjectReport() {
  const [status, setStatus] = useState('loading'); // loading|error|gate|form|noProject|done
  const [projects, setProjects] = useState([]);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const keyRef = useRef(0);
  const nextKey = () => `p-${keyRef.current++}`;
  const withKey = (p) => ({ key: nextKey(), ...p });

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch('/api/submitProjectReport');
        const data = await res.json();
        if (!alive) return;
        if (data.error) throw new Error(data.error);
        setNoProjectFlag(data.response === 'no_project' ? 'no_project' : null);
        if (data.response === 'in_project' && data.projects?.length) {
          setProjects(
            data.projects.map((p) =>
              withKey({
                name: p.projectName || '',
                plan: p.projectPlan || '',
                teamMembers: p.teamMembers || '',
                timeline: p.timeline || '',
                preferredTime: p.preferredTime || '',
                notFinalized: p.finalized === false,
              })
            )
          );
          setStatus('done');
        } else if (data.response === 'no_project') {
          setStatus('noProject');
        } else {
          setStatus('gate');
        }
      } catch (e) {
        if (!alive) return;
        setError(e.message);
        setStatus('error');
      }
    })();
    return () => {
      alive = false;
    };
    // Mount-only: fetch the student's existing report once. withKey is a stable
    // ref-backed id helper, safe to omit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function goToForm() {
    setProjects((prev) => (prev.length ? prev : [withKey(emptyProject())]));
    setError(null);
    setStatus('form');
  }
  function addProject() {
    setProjects((prev) => [...prev, withKey(emptyProject())]);
  }
  function updateProject(key, next) {
    setProjects((prev) => prev.map((p) => (p.key === key ? { ...next, key } : p)));
  }
  function removeProject(key) {
    setProjects((prev) => prev.filter((p) => p.key !== key));
  }

  const canSubmit =
    !submitting &&
    projects.length > 0 &&
    projects.every(
      (p) =>
        p.name.trim() &&
        (p.notFinalized || (p.plan.trim() && p.teamMembers.trim() && p.timeline.trim()))
    );

  async function post(payload, nextStatus, flagResponse) {
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
      setNoProjectFlag(flagResponse);
      setStatus(nextStatus);
    } catch (e) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  }

  function submitReport() {
    if (!canSubmit) return;
    post(
      {
        inProject: true,
        projects: projects.map((p) => ({
          finalized: !p.notFinalized,
          projectName: p.name,
          projectPlan: p.plan,
          teamMembers: p.teamMembers,
          timeline: p.timeline,
          preferredTime: p.preferredTime,
        })),
      },
      'done',
      'in_project'
    );
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
          Ryan wants a quick update on everyone’s group projects. Submit yours and he’ll send a link
          to book a 15-minute check-in.
        </p>
        <div className="neu-inset portal-rise rounded-3xl p-5">
          <p className="text-[15px] font-semibold text-ink">Are you on a group project this summer?</p>
          <div className="mt-4 space-y-2.5">
            <button type="button" onClick={goToForm} className={primaryBtn}>
              Yes
            </button>
            <button
              type="button"
              disabled={submitting}
              onClick={() => post({ inProject: false }, 'noProject', 'no_project')}
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

  // ── not on a project ───────────────────────────────────────────────────────
  if (status === 'noProject') {
    return (
      <div className="portal-rise flex min-h-[55vh] flex-col items-center justify-center text-center">
        <span className="flex h-16 w-16 items-center justify-center rounded-3xl border border-moss/25 bg-moss/[0.08] text-moss shadow-card">
          <CheckCircle2 className="h-8 w-8" strokeWidth={1.9} />
        </span>
        <h1 className="mt-5 font-display text-2xl font-semibold tracking-tight text-ink">All set</h1>
        <p className="mt-2 max-w-xs text-sm text-ink-soft">
          Thanks for letting us know — nothing else to do here.
        </p>
        <button
          type="button"
          onClick={goToForm}
          className="mt-6 text-sm font-semibold text-ink-soft underline underline-offset-4 transition hover:text-ink"
        >
          Actually, I am on a group project
        </button>
      </div>
    );
  }

  // ── done (submitted) ───────────────────────────────────────────────────────
  if (status === 'done') {
    const anyUnfinalized = projects.some((p) => p.notFinalized);
    return (
      <div className="portal-rise flex min-h-[55vh] flex-col items-center justify-center text-center">
        <span className="flex h-16 w-16 items-center justify-center rounded-3xl border border-moss/25 bg-moss/[0.08] text-moss shadow-card">
          <CheckCircle2 className="h-8 w-8" strokeWidth={1.9} />
        </span>
        <h1 className="mt-5 font-display text-2xl font-semibold tracking-tight text-ink">
          {projects.length > 1 ? 'Projects submitted' : 'Report submitted'}
        </h1>
        <p className="mt-2 max-w-xs text-sm text-ink-soft">
          Thanks! Ryan will send your booking link shortly so you can grab a 15-minute slot.
        </p>
        <div className="mt-5 w-full max-w-xs space-y-2 text-left">
          {projects.map((p, i) => (
            <div key={p.key} className="neu-chip flex items-center justify-between gap-2 rounded-xl px-4 py-2.5">
              <span className="min-w-0 truncate text-sm text-ink">{p.name || `Project ${i + 1}`}</span>
              {p.notFinalized && (
                <span className="shrink-0 text-[10px] font-bold uppercase tracking-[0.1em] text-ochre">
                  roster pending
                </span>
              )}
            </div>
          ))}
        </div>
        {anyUnfinalized && (
          <p className="mt-3 max-w-xs text-xs text-ink-soft">
            For any project with a pending roster,{' '}
            <a href={RYAN_MAILTO} className="font-semibold text-terracotta-deep underline underline-offset-2">
              email Ryan
            </a>{' '}
            to finalize your team.
          </p>
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

  // ── form (one card per project) ────────────────────────────────────────────
  return (
    <div className="pb-2">
      <Header sub={projects.length > 1} />
      <p className="portal-rise mb-5 text-sm text-ink-soft">
        Give Ryan the essentials for each project — free-form is fine, just be specific. On more than
        one? Add a card for each.
      </p>

      <div className="space-y-4">
        {projects.map((p, i) => (
          <ProjectCard
            key={p.key}
            index={i}
            project={p}
            canRemove={projects.length > 1}
            onChange={(next) => updateProject(p.key, next)}
            onRemove={() => removeProject(p.key)}
          />
        ))}
      </div>

      <button
        type="button"
        onClick={addProject}
        className="portal-rise mt-3 flex w-full items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-terracotta/45 py-4 text-sm font-bold text-terracotta-deep transition active:scale-[0.99] hover:border-terracotta/70"
      >
        <Plus className="h-5 w-5" strokeWidth={2.6} />
        Add another project
      </button>

      {error && <p className="mt-4 text-sm font-medium text-terracotta-deep">{error}</p>}

      <button type="button" onClick={submitReport} disabled={!canSubmit} className={`${primaryBtn} mt-6`}>
        {submitting ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2.4} />
            Submitting…
          </>
        ) : (
          projects.length > 1 ? 'Submit all' : 'Submit report'
        )}
      </button>
    </div>
  );
}
