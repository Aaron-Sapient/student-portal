'use client';

import { useEffect, useState } from 'react';
import { DateTime } from 'luxon';
import {
  CheckCircle2,
  Circle,
  CircleAlert,
  CircleDashed,
  Compass,
  History,
  Landmark,
  PenLine,
} from 'lucide-react';
import { ZONE, daysUntil, relativeLabel } from '../portalUtils';
import { Bar, ClayLandmark, DocLink, Eyebrow, Halo, SectionDial, Stat } from '../neu';
import { normalizeKey } from '@/lib/collegeKey';

/* ── Season model ───────────────────────────────────────────────────────────
   The senior cycle: Summer essays → Round 1 supps → Round 2 supps. The cycle
   "belongs" to the calendar year of its fall deadlines. */

function getPhases(now) {
  const y = now.month >= 4 ? now.year : now.year - 1;
  const dt = (m, d) => DateTime.fromObject({ year: y, month: m, day: d }, { zone: ZONE });
  return [
    {
      key: 'summer',
      label: 'Summer',
      work: 'Common App main essay + UC PIQs',
      start: dt(6, 15),
      end: dt(8, 31),
    },
    {
      key: 'r1',
      label: 'Round 1',
      work: 'ED · EA · REA supplementals',
      start: dt(9, 1),
      end: dt(10, 15),
      milestones: [{ label: 'Round 1 list locked', date: dt(9, 1) }],
    },
    {
      key: 'r2',
      label: 'Round 2',
      work: 'ED2 · RD supplementals',
      start: dt(10, 16),
      end: dt(12, 15),
      // UC filing period closes Dec 1 for Fall 2026 (freshman + transfer — verified
      // admission.universityofcalifornia.edu 2026-06-15). PIQs drafted in Summer, submitted here.
      milestones: [{ label: 'UC applications due', date: dt(12, 1) }],
    },
  ];
}

const ROUND1 = /^(REA|SCEA|EA|ED1?)$/i;

/* ── Small neumorphic primitives ────────────────────────────────────────── */

function HwBadge({ status }) {
  const map = {
    done: { icon: CheckCircle2, label: 'Done', cls: 'text-moss' },
    partly: { icon: CircleDashed, label: 'Partly done', cls: 'text-terracotta-deep' },
  };
  const { icon: Icon, label, cls } = map[status] || {
    icon: Circle,
    label: 'In progress',
    cls: 'text-ink-faint',
  };
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-semibold ${cls}`}>
      <Icon className="h-4 w-4" strokeWidth={2.2} />
      {label}
    </span>
  );
}

function RangeBadge({ range }) {
  if (!range) return null;
  const r = range.toLowerCase();
  const cls =
    r === 'reach' ? 'text-terracotta-deep' : r === 'target' ? 'text-moss' : 'text-ink-soft';
  return (
    <span
      className={`neu-chip shrink-0 rounded-full px-3 py-1.5 text-[10px] font-bold uppercase leading-none tracking-[0.12em] ${cls}`}
    >
      {range}
    </span>
  );
}

/* ── Hero gauge cluster ─────────────────────────────────────────────────────
   The Home "Choice score" layout retold for application progress: the Overall
   wheel (sheet's "Total progress") sits left like a speedometer; the three
   workstreams — Common App tasks, UC PIQs, supplementals — are fill-lines
   beside it, in the same identity hues as Home's sub-scores. */

const avgPct = (list) => {
  const vals = list.filter((v) => typeof v === 'number');
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
};

function GaugeLine({ label, value, fill }) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-[10px] font-semibold uppercase tracking-[0.13em] text-ink-faint">
          {label}
        </span>
        <span className="shrink-0 font-display text-base font-semibold leading-none text-ink">
          {value === null ? '—' : `${Math.round(value * 100)}%`}
        </span>
      </div>
      <div className="mt-1.5 flex">
        <Bar value={value ?? 0} fillClassName={fill} />
      </div>
    </div>
  );
}

function ProgressCluster({ data }) {
  const { summary, tasks, piqs, schools } = data;
  // PIQ-flavored tasks belong to the UC line, not the Common App one.
  const gauges = [
    {
      key: 'ca',
      label: 'CA',
      value: avgPct(tasks.filter((t) => !/\b(uc|piq)/i.test(t.name)).map((t) => t.pct)),
      fill: 'bg-gradient-to-r from-moss/70 to-moss',
    },
    {
      key: 'uc',
      label: 'UC',
      value: avgPct(piqs.filter((p) => p.chosen).map((p) => p.pct)),
      fill: 'bg-gradient-to-r from-ochre/70 to-ochre',
    },
    {
      key: 'sup',
      label: 'SUP',
      value: avgPct(schools.map((s) => s.pct)),
      fill: 'bg-gradient-to-r from-terracotta-soft/80 to-terracotta-soft',
    },
  ];
  const overall = summary.totalProgress;
  return (
    <section
      className="portal-rise neu-raised rounded-[2.5rem] p-6"
      style={{ animationDelay: '90ms' }}
    >
      <Eyebrow>Application progress</Eyebrow>
      <div className="mt-4 flex items-center gap-5">
        <Halo
          rings={[{ value: overall ?? 0, className: 'text-terracotta' }]}
          size={148}
          stroke={13}
        >
          <p className="font-display text-4xl font-semibold leading-none text-ink">
            {overall === null ? '—' : Math.round(overall * 100)}
            {overall !== null && <span className="text-lg text-ink-soft">%</span>}
          </p>
          <p className="mt-1 text-[9px] font-semibold uppercase tracking-[0.15em] text-ink-faint">
            overall
          </p>
        </Halo>
        <div className="flex min-w-0 flex-1 flex-col gap-3.5">
          {gauges.map((g) => (
            <GaugeLine key={g.key} label={g.label} value={g.value} fill={g.fill} />
          ))}
        </div>
      </div>
    </section>
  );
}

/* ── Section dial config (icons over text, by design) ───────────────────── */

// Icon audit: no glyph here repeats a bottom-dock or other-dial icon — the
// bottom Colleges tab is already a mortarboard, so Schools gets Landmark, and
// the session log gets History (the bottom Meetings tab owns the calendar).
const SECTIONS = [
  { key: 'overview', label: 'Overview', icon: Compass },
  { key: 'schools', label: 'Schools', icon: Landmark },
  { key: 'essays', label: 'Essays', icon: PenLine },
  { key: 'sessions', label: 'Sessions', icon: History },
];

// Build the writing links from the /api/writing map: a fixed per-doc URL
// (/write/<docId>) plus a ?tab=<tabId> deep link for a college's supplement tab.
function buildWritingLinks(map) {
  const find = (t) => (map?.docs || []).find((d) => d.docType === t);
  const ca = find('COMMON_APP');
  const piq = find('UC_PIQ');
  const supp = find('SUPPLEMENTAL');
  const suppTabByKey = {};
  for (const t of supp?.tabs || []) if (t.sync_key) suppTabByKey[t.sync_key] = t.id;
  return {
    ready: !!map,
    commonAppHref: ca ? `/write/${ca.id}` : null,
    ucPiqHref: piq ? `/write/${piq.id}` : null,
    suppHref: (name) => {
      if (!supp) return null;
      const tabId = suppTabByKey[normalizeKey(name)];
      return tabId ? `/write/${supp.id}?tab=${tabId}` : `/write/${supp.id}`;
    },
  };
}

// Which Common App / UC PIQ writing doc (if any) an Essays task card opens.
function taskWritingHref(task, writing) {
  const n = (task?.name || '').toLowerCase();
  if (/common app|main essay|personal statement|^ca\b/.test(n)) return writing.commonAppHref;
  if (/\bpiq|uc /.test(n)) return writing.ucPiqHref;
  return null;
}

/* ── Overview ───────────────────────────────────────────────────────────── */
/* (Eyebrow / Bar / Stat / SectionDial come from the shared ../neu kit.) */

function PhaseTimeline({ phases, now }) {
  const current = phases.find((p) => now <= p.end.endOf('day'));
  return (
    <div className="neu-raised rounded-[2rem] p-6">
      <Eyebrow>The season</Eyebrow>
      <ol className="mt-5">
        {phases.map((p, i) => {
          const done = now > p.end.endOf('day');
          const active = p === current;
          return (
            <li key={p.key} className="relative flex gap-4 pb-6 last:pb-0">
              {i < phases.length - 1 && (
                <span className="absolute bottom-1 left-[7px] top-5 w-px bg-ink-faint/25" />
              )}
              <span className="flex h-4 w-4 shrink-0 items-center justify-center pt-1">
                {done ? (
                  <CheckCircle2 className="h-4 w-4 text-moss" strokeWidth={2.4} />
                ) : active ? (
                  <span className="neu-pulse h-3 w-3 rounded-full bg-terracotta" />
                ) : (
                  <span className="h-3 w-3 rounded-full border-2 border-ink-faint/50" />
                )}
              </span>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-ink">
                  {p.label}
                  <span className="ml-2 text-xs font-medium text-ink-faint">
                    {p.start.toFormat('LLL d')} – {p.end.toFormat('LLL d')}
                  </span>
                </p>
                <p className="mt-0.5 text-xs text-ink-soft">{p.work}</p>
                {p.milestones?.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {p.milestones.map((m) => {
                      const passed = m.date ? now > m.date.endOf('day') : false;
                      const Icon = m.date ? (passed ? CheckCircle2 : CircleAlert) : null;
                      const cls = passed
                        ? 'bg-moss/[0.10] text-moss'
                        : 'bg-terracotta/[0.09] text-terracotta-deep';
                      return (
                        <span
                          key={m.label}
                          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] ${cls}`}
                        >
                          {Icon && <Icon className="h-3 w-3" strokeWidth={2.4} />}
                          {m.label}
                          {m.date && (
                            <span className="font-bold tracking-normal">
                              {m.date.toFormat('LLL d')}
                            </span>
                          )}
                        </span>
                      );
                    })}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function ThisWeekCard({ meeting }) {
  if (!meeting?.homework) return null;
  const dt = meeting.date ? DateTime.fromISO(meeting.date, { zone: ZONE }) : null;
  return (
    <div className="neu-raised rounded-[2rem] p-6">
      <div className="flex items-center justify-between gap-3">
        <Eyebrow>This week with Aaron</Eyebrow>
        {dt && (
          <span className="text-xs font-semibold text-ink-faint">{dt.toFormat('ccc, LLL d')}</span>
        )}
      </div>
      {meeting.project && (
        <p className="mt-3 font-display text-lg font-semibold leading-snug text-ink">
          {meeting.project}
        </p>
      )}
      <p className="mt-1.5 text-sm leading-relaxed text-ink-soft">{meeting.homework}</p>
      <div className="mt-4">
        <HwBadge status={meeting.hwStatus} />
      </div>
    </div>
  );
}

function Overview({ data, now, phases }) {
  const { summary, schools, meetings } = data;
  const confirmed = schools.filter((s) => s.status === 'confirmed').length;
  const latest = meetings[meetings.length - 1];
  return (
    <div className="space-y-4">
      <ProgressCluster data={data} />

      <section
        className="portal-rise grid grid-cols-3 gap-3.5"
        style={{ animationDelay: '150ms' }}
      >
        <Stat value={schools.length} label="On your list" />
        <Stat value={confirmed} label="Confirmed" />
        <Stat value={summary.privatesPlanned} label="List goal" />
      </section>

      <section className="portal-rise" style={{ animationDelay: '210ms' }}>
        <PhaseTimeline phases={phases} now={now} />
      </section>

      <section className="portal-rise" style={{ animationDelay: '270ms' }}>
        <ThisWeekCard meeting={latest} />
      </section>
    </div>
  );
}

/* ── Schools ────────────────────────────────────────────────────────────── */

const STATUS_DOT = {
  confirmed: 'bg-moss',
  interested: 'bg-terracotta-soft',
  recommended: 'bg-ink-faint',
  discussing: 'bg-ink-faint',
};

function SchoolCard({ school, delay, writing }) {
  const suppHref = (writing?.ready && writing.suppHref(school.name)) || school.suppUrl;
  const dt = school.deadline ? DateTime.fromISO(school.deadline, { zone: ZONE }) : null;
  return (
    <article
      className="portal-rise neu-raised rounded-[1.75rem] p-5"
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-display text-[1.05rem] font-semibold leading-snug text-ink">
            {school.name}
          </h3>
          <p className="mt-1.5 flex items-center gap-1.5 text-xs font-medium text-ink-soft">
            {school.status && (
              <span
                className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[school.status] || 'bg-ink-faint'}`}
              />
            )}
            {school.status && school.status[0].toUpperCase() + school.status.slice(1)}
            {school.major && <span className="text-ink-faint">· {school.major}</span>}
          </p>
        </div>
        <RangeBadge range={school.range} />
      </div>

      <div className="mt-4 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          {school.decision && (
            <span className="neu-inset rounded-full px-3 py-1.5 text-[11px] font-bold leading-none text-ink-soft">
              {school.decision}
            </span>
          )}
          {dt && (
            <span className="truncate text-xs font-medium text-ink-faint">
              {dt.toFormat('LLL d')} · {relativeLabel(daysUntil(dt))}
            </span>
          )}
        </div>
        {suppHref && (
          <DocLink href={suppHref} label={`Open ${school.name} supplemental essays`} />
        )}
      </div>

      {school.pct !== null && (
        <div className="mt-4 flex items-center gap-3">
          <Bar value={school.pct} />
          <span className="w-9 shrink-0 text-right text-xs font-semibold text-ink-soft">
            {Math.round(school.pct * 100)}%
          </span>
        </div>
      )}
    </article>
  );
}

function Schools({ data, writing }) {
  const { schools, ucs, recommenders } = data;
  const r1 = schools.filter((s) => ROUND1.test(s.decision || ''));
  const r2 = schools.filter((s) => !ROUND1.test(s.decision || ''));
  // Stagger by precomputed slot (header + cards per group), capped so long
  // lists don't crawl in.
  const slot = (base, i) => Math.min(base + i * 55, 480);
  const r2Base = 145 + (r1.length ? (r1.length + 1) * 55 : 0);
  const tailBase = Math.min(r2Base + (r2.length ? (r2.length + 1) * 55 : 0), 480);

  const group = (label, list, base) =>
    list.length > 0 && (
      <section className="space-y-3.5">
        <p
          className="portal-rise px-1 text-xs font-semibold uppercase tracking-[0.13em] text-ink-faint"
          style={{ animationDelay: `${slot(base, 0)}ms` }}
        >
          {label}
        </p>
        {list.map((s, i) => (
          <SchoolCard key={s.name} school={s} delay={slot(base, i + 1)} writing={writing} />
        ))}
      </section>
    );

  return (
    <div className="space-y-6">
      {group('Round 1 · essays due Oct 15', r1, 90)}
      {group('Round 2 · essays due Dec 15', r2, r2Base)}

      {ucs.length > 0 && (
        <section
          className="portal-rise neu-raised rounded-[2rem] p-6"
          style={{ animationDelay: `${tailBase}ms` }}
        >
          <Eyebrow>University of California</Eyebrow>
          <p className="mt-2 text-sm leading-relaxed text-ink-soft">
            One application covers every campus — your four PIQs do the heavy lifting.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            {ucs.map((u) => (
              <span
                key={u.name}
                className="neu-chip rounded-full px-3.5 py-2 text-xs font-semibold text-ink"
              >
                {u.name === 'UCLA' ? u.name : u.name.replace(/^UC /, '')}
              </span>
            ))}
          </div>
        </section>
      )}

      {recommenders.length > 0 && (
        <section
          className="portal-rise neu-raised rounded-[2rem] p-6"
          style={{ animationDelay: `${Math.min(tailBase + 60, 540)}ms` }}
        >
          <Eyebrow>Recommendation letters</Eyebrow>
          <ul className="mt-4 space-y-3">
            {recommenders.map((r) => (
              <li key={r.writer} className="flex items-center justify-between gap-3">
                <span className="min-w-0 truncate text-sm font-medium text-ink">
                  {r.writer}
                  {r.subject && r.subject !== 'n/a' && (
                    <span className="text-ink-faint"> · {r.subject}</span>
                  )}
                </span>
                {r.done ? (
                  <CheckCircle2 className="h-4.5 w-4.5 shrink-0 text-moss" strokeWidth={2.2} />
                ) : (
                  <Circle className="h-4.5 w-4.5 shrink-0 text-ink-faint/60" strokeWidth={2.2} />
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/* ── Essays ─────────────────────────────────────────────────────────────── */

function TaskCard({ task, delay, href }) {
  const openHref = href || task.docUrl;
  return (
    <article
      className="portal-rise neu-raised rounded-[1.75rem] p-5"
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-display text-[1.05rem] font-semibold leading-snug text-ink">
            {task.name}
          </h3>
          {task.notes && (
            <p className="mt-0.5 text-xs font-medium text-terracotta-deep">{task.notes}</p>
          )}
        </div>
        {openHref && <DocLink href={openHref} label={`Open your ${task.name} doc`} />}
      </div>
      <div className="mt-4 flex items-center gap-3">
        <Bar value={task.pct} />
        <span className="w-9 shrink-0 text-right text-xs font-semibold text-ink-soft">
          {Math.round((task.pct || 0) * 100)}%
        </span>
      </div>
    </article>
  );
}

function Essays({ data, writing }) {
  const { tasks, piqs } = data;
  const chosen = piqs.filter((p) => p.chosen).length;
  return (
    <div className="space-y-4">
      <div className="space-y-3.5">
        {tasks.map((t, i) => (
          <TaskCard key={t.name} task={t} delay={90 + i * 60} href={taskWritingHref(t, writing)} />
        ))}
      </div>

      {piqs.length > 0 && (
        <section
          className="portal-rise neu-raised rounded-[2rem] p-6"
          style={{ animationDelay: `${90 + tasks.length * 60}ms` }}
        >
          <div className="flex items-center justify-between gap-3">
            <Eyebrow>Personal Insight Questions</Eyebrow>
            <div className="flex shrink-0 items-center gap-2.5">
              <span className="text-xs font-semibold text-ink-faint">{chosen} of 4 picked</span>
              {writing?.ucPiqHref && (
                <DocLink href={writing.ucPiqHref} label="Open your UC PIQ doc" />
              )}
            </div>
          </div>
          <ul className="mt-4 space-y-3.5">
            {piqs.map((p) => (
              <li
                key={p.prompt}
                className={`flex items-start gap-3 ${p.chosen ? '' : 'opacity-45'}`}
              >
                {p.chosen ? (
                  <CheckCircle2 className="mt-0.5 h-4.5 w-4.5 shrink-0 text-moss" strokeWidth={2.2} />
                ) : (
                  <Circle className="mt-0.5 h-4.5 w-4.5 shrink-0 text-ink-faint/60" strokeWidth={2.2} />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-ink">{p.prompt}</p>
                  {p.notes && <p className="mt-0.5 text-xs text-ink-soft">{p.notes}</p>}
                </div>
                {p.chosen && p.pct !== null && (
                  <span className="shrink-0 text-xs font-semibold text-ink-soft">
                    {Math.round(p.pct * 100)}%
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/* ── Meetings ───────────────────────────────────────────────────────────── */

function MeetingCard({ meeting, latest, delay }) {
  const dt = meeting.date ? DateTime.fromISO(meeting.date, { zone: ZONE }) : null;
  return (
    <article
      className="portal-rise neu-raised rounded-[1.75rem] p-5"
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-ink">
          {latest && (
            <span className="mr-2 rounded-full bg-terracotta/[0.09] px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.08em] text-terracotta-deep">
              Latest
            </span>
          )}
          {dt ? dt.toFormat('ccc, LLL d') : 'Session'}
        </p>
        {meeting.project && (
          <span className="neu-inset max-w-[45%] truncate rounded-full px-3 py-1.5 text-[11px] font-semibold leading-none text-ink-soft">
            {meeting.project}
            {meeting.pct !== null && ` · ${Math.round(meeting.pct * 100)}%`}
          </span>
        )}
      </div>

      {meeting.agenda && (
        <p className="mt-3 text-sm leading-relaxed text-ink-soft">{meeting.agenda}</p>
      )}

      {meeting.homework && (
        <div className="neu-inset mt-3.5 rounded-2xl p-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-ink-faint">
              Homework
            </p>
            <HwBadge status={meeting.hwStatus} />
          </div>
          <p className="mt-2 text-sm leading-relaxed text-ink">{meeting.homework}</p>
        </div>
      )}
    </article>
  );
}

function Sessions({ data }) {
  const ordered = [...data.meetings].reverse();
  if (ordered.length === 0) {
    return (
      <div className="portal-rise flex min-h-[40vh] flex-col items-center justify-center text-center">
        <span className="neu-raised flex h-16 w-16 items-center justify-center rounded-3xl text-terracotta">
          <History className="h-7 w-7" strokeWidth={1.8} />
        </span>
        <p className="mt-5 font-display text-xl font-semibold text-ink">No sessions yet</p>
        <p className="mt-1.5 max-w-xs text-sm text-ink-soft">
          After each meeting with Aaron, the agenda and homework land here.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <p
        className="portal-rise px-1 text-xs leading-relaxed text-ink-faint"
        style={{ animationDelay: '90ms' }}
      >
        Your weekly essay sessions with Aaron — what you covered, and what’s next.
      </p>
      {ordered.map((m, i) => (
        <MeetingCard
          key={`${m.date}-${i}`}
          meeting={m}
          latest={i === 0}
          delay={130 + Math.min(i, 6) * 55}
        />
      ))}
    </div>
  );
}

/* ── Page shell ─────────────────────────────────────────────────────────── */

function Skeleton() {
  return (
    <div className="space-y-7">
      <div>
        <div className="portal-skeleton h-3 w-44 rounded-full" />
        <div className="portal-skeleton mt-3 h-11 w-52 rounded-2xl" />
      </div>
      <div className="portal-skeleton mx-auto h-16 w-full max-w-sm rounded-full" />
      <div className="portal-skeleton h-[228px] rounded-[2.5rem]" />
      <div className="grid grid-cols-3 gap-3.5">
        <div className="portal-skeleton h-[84px] rounded-3xl" />
        <div className="portal-skeleton h-[84px] rounded-3xl" />
        <div className="portal-skeleton h-[84px] rounded-3xl" />
      </div>
    </div>
  );
}

export default function CollegesView({ endpoint = '/api/colleges' }) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const [section, setSection] = useState('overview');
  const [writingMap, setWritingMap] = useState(null);

  // The writing map (doc + tab ids) backs the essay/supplement links. Derived
  // from the colleges endpoint: a parent carries ?student=, a student doesn't.
  useEffect(() => {
    let alive = true;
    const studentParam = (endpoint.match(/[?&]student=([^&]+)/) || [])[1] || '';
    const mapEndpoint = `/api/writing${studentParam ? `?student=${studentParam}` : ''}`;
    fetch(mapEndpoint)
      .then((r) => r.json())
      .then((m) => {
        if (alive && m && !m.error) setWritingMap(m);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [endpoint]);

  useEffect(() => {
    let alive = true;
    fetch(endpoint)
      .then((r) => r.json())
      .then((data) => {
        if (!alive) return;
        if (data?.error) setState({ loading: false, error: data.error, data: null });
        else setState({ loading: false, error: null, data });
      })
      .catch(() => {
        if (!alive) return;
        setState({
          loading: false,
          error: 'We couldn’t load your college list. Try again shortly.',
          data: null,
        });
      });
    return () => {
      alive = false;
    };
  }, [endpoint]);

  if (state.loading) return <Skeleton />;

  if (state.error) {
    const noList = /college list yet/i.test(state.error);
    return (
      <div className="portal-rise mt-10 rounded-3xl border border-terracotta/25 bg-clay-50 p-6 text-center">
        <CircleAlert className="mx-auto h-7 w-7 text-terracotta" strokeWidth={2} />
        <p className="mt-3 font-display text-lg font-semibold text-ink">
          {noList ? 'Coming soon' : 'Something’s off'}
        </p>
        <p className="mt-1 text-sm text-ink-soft">
          {noList
            ? 'Your college list hasn’t been set up yet — we’ll build it together.'
            : state.error}
        </p>
      </div>
    );
  }

  const writing = buildWritingLinks(writingMap);

  const now = DateTime.now().setZone(ZONE);
  const phases = getPhases(now);
  const current = phases.find((p) => now <= p.end.endOf('day'));
  const eyebrow = !current
    ? 'Season complete — decisions ahead'
    : now < current.start
      ? `${current.label} begins ${current.start.toFormat('LLL d')}`
      : `${current.label} · through ${current.end.toFormat('LLL d')}`;

  return (
    <div className="space-y-7">
      <header className="portal-rise flex items-center gap-4 sm:gap-5" style={{ animationDelay: '0ms' }}>
        <ClayLandmark scale={1.25} />
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-ink-faint">
            {eyebrow}
          </p>
          <h1 className="mt-1.5 font-display text-[2rem] font-semibold leading-[1.08] tracking-tight text-ink sm:text-[2.6rem] sm:leading-[1.05]">
            Your apps for<br />{' '}
            <span className="text-terracotta">colleges.</span>
          </h1>
        </div>
      </header>

      <div className="portal-rise" style={{ animationDelay: '50ms' }}>
        <SectionDial sections={SECTIONS} value={section} onChange={setSection} />
      </div>

      {/* Keyed so each section replays the staggered rise on switch. */}
      <div key={section}>
        {section === 'overview' && <Overview data={state.data} now={now} phases={phases} />}
        {section === 'schools' && <Schools data={state.data} writing={writing} />}
        {section === 'essays' && <Essays data={state.data} writing={writing} />}
        {section === 'sessions' && <Sessions data={state.data} />}
      </div>
    </div>
  );
}
