'use client';

// Home dashboard sections shared by the student Home tab and the parent
// portal's child overview: the score gauge cluster, the weekly readout, the
// aggregate progress line, and the project cards. Student-only chrome (coach
// card, next-meeting pointer, check-in signals) stays in home/page.js.

import { DateTime } from 'luxon';
import { Rocket } from 'lucide-react';
import { Bar, DeltaLines, DocLink, Eyebrow, Halo, IconTile } from './neu';
import { ZONE, parseSheetDate, daysUntil, relativeLabel } from './portalUtils';

export function Delta({ value }) {
  if (value === null || value === 0) return null;
  const up = value > 0;
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10px] font-bold leading-none ${
        up ? 'bg-moss/[0.14] text-moss' : 'bg-terracotta/[0.1] text-terracotta-deep'
      }`}
    >
      {up ? `+${value}` : value}
    </span>
  );
}

// Fail closed (Coach rule): stale numbers are never presented as fresh.
export function liveScores(scores) {
  const live = scores && !scores.stale ? scores.latest : null;
  const prev = scores && !scores.stale ? scores.prev : null;
  const d = (k) =>
    live && prev && live[k] != null && prev[k] != null ? live[k] - prev[k] : null;
  return { live, d };
}

// The gauge cluster — "car dashboard, hyper premium": the Overall ring sits
// upper-left like a speedometer; the three sub-scores are fill-lines beside it.
// This card is the ONE place the scores live (info-once rule).
export const SUBS = [
  {
    key: 'academic',
    label: 'Academic',
    fill: 'bg-gradient-to-r from-moss/70 to-moss',
  },
  {
    key: 'ec',
    label: 'Extracurricular',
    fill: 'bg-gradient-to-r from-ochre/70 to-ochre',
  },
  {
    key: 'leadership',
    label: 'Leadership',
    fill: 'bg-gradient-to-r from-terracotta-soft/80 to-terracotta-soft',
  },
];

export function ScoreLine({ sub, live, d }) {
  const v = live?.[sub.key];
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-[10px] font-semibold uppercase tracking-[0.13em] text-ink-faint">
          {sub.label}
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          <span className="font-display text-base font-semibold leading-none text-ink">
            {v ?? '—'}
          </span>
          <Delta value={d(sub.key)} />
        </span>
      </div>
      <div className="mt-1.5 flex">
        <Bar value={(v ?? 0) / 100} fillClassName={sub.fill} />
      </div>
    </div>
  );
}

// Grayed-out gauge for students without enough recent grades to score
// (lib/gradeData → home-data sets scores.insufficientData). The cron skips them
// too, so no number is ever manufactured. Phrasing stays forward-looking.
function InsufficientScores() {
  return (
    <section
      className="portal-rise neu-raised rounded-[2.5rem] p-6"
      style={{ animationDelay: '90ms' }}
    >
      <div className="mb-4 flex items-center gap-2">
        <Eyebrow>Choice score</Eyebrow>
      </div>
      <div className="flex items-center gap-5">
        <Halo rings={[{ value: 0, className: 'text-ink/15' }]} size={148} stroke={13}>
          <p className="font-display text-3xl font-semibold text-ink-faint/70">—</p>
          <p className="mt-1 max-w-[5.5rem] text-center text-[9px] font-semibold uppercase leading-relaxed tracking-[0.12em] text-ink-faint">
            No recent grades
          </p>
        </Halo>
        <div className="flex min-w-0 flex-1 flex-col gap-3.5">
          {SUBS.map((sub) => (
            <div key={sub.key}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-[10px] font-semibold uppercase tracking-[0.13em] text-ink-faint/70">
                  {sub.label}
                </span>
                <span className="font-display text-base font-semibold leading-none text-ink-faint/60">
                  —
                </span>
              </div>
              <div className="mt-1.5 flex">
                <Bar value={0} fillClassName="bg-ink/10" />
              </div>
            </div>
          ))}
        </div>
      </div>
      <p className="mt-5 text-center text-xs leading-relaxed text-ink-soft">
        Your Choice Score will appear here once this term’s grades are on file.
      </p>
    </section>
  );
}

export function GaugeCluster({ scores }) {
  if (scores?.insufficientData) return <InsufficientScores />;
  const { live, d } = liveScores(scores);
  return (
    <section
      className="portal-rise neu-raised rounded-[2.5rem] p-6"
      style={{ animationDelay: '90ms' }}
    >
      <div className="mb-4 flex items-center gap-2">
        <Eyebrow>Choice score</Eyebrow>
        {/* The scoring rubric is still being calibrated — flag the numbers as such. */}
        <span
          title="Scores are a work in progress — the rubric is still being tuned."
          className="inline-flex items-center justify-center rounded-full bg-ochre/[0.14] px-2.5 py-1 text-[9px] font-bold uppercase tracking-[0.14em] text-ochre"
        >
          {/* all-caps pills sit optically off-center: tracking leaves a trailing
              letter-space (cancelled by the -mr) and the em box's descender room
              floats cap-only text high (the 0.5px nudge). */}
          <span className="-mr-[0.14em] translate-y-[0.5px] leading-none">Beta</span>
        </span>
      </div>
      <div className="flex items-center gap-5">
        <Halo
          rings={[{ value: (live?.overall ?? 0) / 100, className: 'text-terracotta' }]}
          size={148}
          stroke={13}
        >
          {live ? (
            <>
              <p className="font-display text-4xl font-semibold leading-none text-ink">
                {live.overall ?? '—'}
              </p>
              <div className="mt-1 flex items-center gap-1">
                <p className="text-[9px] font-semibold uppercase tracking-[0.15em] text-ink-faint">
                  overall
                </p>
                <Delta value={d('overall')} />
              </div>
            </>
          ) : (
            <>
              <p className="font-display text-2xl font-semibold text-ink-faint">—</p>
              <p className="mt-1 max-w-[5.5rem] text-center text-[9px] font-semibold uppercase leading-relaxed tracking-[0.12em] text-ink-faint">
                {scores?.stale ? 'Updating' : 'First scores this week'}
              </p>
            </>
          )}
        </Halo>
        <div className="flex min-w-0 flex-1 flex-col gap-3.5">
          {SUBS.map((sub) => (
            <ScoreLine key={sub.key} sub={sub} live={live} d={d} />
          ))}
        </div>
      </div>
    </section>
  );
}

// The aggregated explanation, in its own quiet container below the gauges —
// the dashboard's trip-computer readout: Claude's insight + the delta slope
// chart. Max 4 check-ins, anchored at zero on the prior check-in so even a
// single delta draws a diagonal.
export function ScoreReadout({ scores }) {
  const { live } = liveScores(scores);
  const h = scores?.history || [];
  const fmt = (iso) => DateTime.fromISO(iso, { zone: ZONE }).toFormat('LLL d');
  const entries = [];
  for (let i = 1; i < h.length; i++) {
    const delta = (k) => (h[i][k] != null && h[i - 1][k] != null ? h[i][k] - h[i - 1][k] : 0);
    entries.push({
      label: fmt(h[i].date),
      deltas: {
        overall: delta('overall'),
        academic: delta('academic'),
        ec: delta('ec'),
        leadership: delta('leadership'),
      },
    });
  }
  const recent = entries.slice(-4);
  const anchorRow = h[h.length - recent.length - 1];
  const points = anchorRow
    ? [
        {
          label: fmt(anchorRow.date),
          deltas: { overall: 0, academic: 0, ec: 0, leadership: 0 },
        },
        ...recent,
      ]
    : [];
  if (!live?.insight && points.length < 2) return null;
  return (
    <section
      className="portal-rise neu-raised rounded-[2rem] p-5"
      style={{ animationDelay: '330ms' }}
    >
      <Eyebrow>This week’s read</Eyebrow>
      {live?.insight && (
        // Claude-authored prose reads in the serif voice (same convention as the
        // Claude apps): the assistant speaks in serif, the UI chrome in sans.
        <p className="mt-2.5 font-display text-[15px] leading-relaxed text-ink-soft">
          {live.insight}
        </p>
      )}
      {points.length >= 2 && (
        <div className="neu-inset mt-4 rounded-2xl px-3.5 pb-2.5 pt-3">
          <DeltaLines points={points} />
          <p className="mt-2 text-center text-[9px] font-semibold uppercase tracking-[0.16em] text-ink-faint">
            score movement across check-ins
          </p>
        </div>
      )}
    </section>
  );
}

// "Project progress" — real work completion across 🏆 Comps & Projects (seniors
// keep working on projects too, so this never switches source).
export function ProgressLine({ progress }) {
  if (!progress) return null;
  return (
    <section
      className="portal-rise neu-raised rounded-[2rem] p-5"
      style={{ animationDelay: '210ms' }}
    >
      <div className="flex items-baseline justify-between gap-3">
        <Eyebrow>Project progress</Eyebrow>
        <span className="text-[11px] font-medium text-ink-faint">
          across {progress.count} active project{progress.count === 1 ? '' : 's'}
        </span>
      </div>
      <div className="mt-3.5 flex items-center gap-3">
        <Bar value={progress.value} />
        <span className="shrink-0 font-display text-lg font-semibold leading-none text-ink">
          {Math.round(progress.value * 100)}%
        </span>
      </div>
    </section>
  );
}

/* ── Projects (canonical home of deadlines + progress) ──────────────────── */

export function ProjectCard({ project, delay }) {
  const dt = parseSheetDate(project.endDate);
  const progress = typeof project.progress === 'number' ? project.progress : null;
  return (
    <article
      className="portal-rise neu-raised rounded-[1.75rem] p-5"
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-display text-[1.05rem] font-semibold leading-snug text-ink">
            {project.name || 'Untitled project'}
          </h3>
          <p className="mt-1 text-xs font-medium text-ink-soft">
            {project.owner && <>With {project.owner}</>}
            {project.owner && dt && ' · '}
            {dt && (
              <>
                due {dt.toFormat('LLL d')}
                <span className="text-terracotta-deep"> · {relativeLabel(daysUntil(dt))}</span>
              </>
            )}
          </p>
        </div>
        {project.link && <DocLink href={project.link} label={`Open ${project.name}`} />}
      </div>
      {progress !== null && (
        <div className="mt-4 flex items-center gap-3">
          <Bar value={progress} />
          <span className="w-9 shrink-0 text-right text-xs font-semibold text-ink-soft">
            {Math.round(progress * 100)}%
          </span>
        </div>
      )}
    </article>
  );
}

export function Projects({ data }) {
  const projects = (data.activeProjects || [])
    .map((p) => ({ ...p, dt: parseSheetDate(p.endDate) }))
    .sort((a, b) => (a.dt && b.dt ? a.dt - b.dt : a.dt ? -1 : 1));

  if (projects.length === 0) {
    return (
      <div className="portal-rise flex min-h-[40vh] flex-col items-center justify-center text-center">
        <IconTile icon={Rocket} size="lg" />
        <p className="mt-5 font-display text-xl font-semibold text-ink">Nothing in flight</p>
        <p className="mt-1.5 max-w-xs text-sm text-ink-soft">
          New competitions and projects will show up here once they’re scoped.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3.5">
      {projects.map((p, i) => (
        <ProjectCard key={`${p.name}-${i}`} project={p} delay={90 + Math.min(i, 6) * 55} />
      ))}
    </div>
  );
}
