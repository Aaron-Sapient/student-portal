import { DateTime } from 'luxon';
import {
  CalendarDays,
  CheckCircle2,
  CircleAlert,
  CircleDashed,
  FileText,
  Landmark,
  Video,
} from 'lucide-react';
import { Bar, Eyebrow, Halo } from '@/app/(portal)/neu';
import { ZONE } from '@/app/(portal)/portalUtils';

/* Demo-only sections. Everything here is presentational and takes its values
   from app/demo/demoData.js — no hooks, no fetch, no client state. The score
   gauge and the movement chart are NOT re-authored here: /demo renders the real
   GaugeCluster and ScoreReadout so the room is looking at the actual product. */

/* ── Masthead ───────────────────────────────────────────────────────────── */

export function Masthead({ student, today, note }) {
  return (
    <header className="portal-rise" style={{ animationDelay: '0ms' }}>
      <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-6">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-ink-faint">
            {today.toFormat('cccc, LLLL d')}
          </p>
          <h1 className="mt-2 font-display text-[3.1rem] font-semibold leading-[1.02] tracking-tight text-ink">
            Here’s how <span className="text-terracotta">{student.first}</span> is doing.
          </h1>
        </div>

        {/* Who this is, at a glance — the room's orientation, in data rather
            than in a sentence explaining the page. */}
        <dl className="flex shrink-0 flex-wrap items-start gap-x-9 gap-y-4 border-l border-ink-faint/20 pl-9">
          {[
            ['Student', student.name],
            ['Year', `${student.year} · Class of ${student.gradYear}`],
            ['Counselor', student.counselor],
            ['Essay coach', student.essayCoach],
          ].map(([k, v]) => (
            <div key={k}>
              <dt className="text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-faint">
                {k}
              </dt>
              <dd className="mt-1 text-[15px] font-semibold text-ink">{v}</dd>
            </div>
          ))}
        </dl>
      </div>

      {/* The human voice. Same treatment as the student portal's CoachCard: a
          quiet serif line behind a terracotta rule, never a card. */}
      <p className="mt-8 max-w-[74ch] border-l-2 border-terracotta/40 pl-5 font-display text-[17px] leading-relaxed text-ink-soft">
        {note}
      </p>
    </header>
  );
}

/* ── The application ────────────────────────────────────────────────────── */

export function ApplicationCluster({ application, delay = 0 }) {
  return (
    <section className="portal-rise neu-raised rounded-[2.5rem] p-7" style={{ animationDelay: `${delay}ms` }}>
      <Eyebrow>Application progress</Eyebrow>
      <div className="mt-5 flex items-center gap-5">
        <Halo rings={[{ value: application.overall, className: 'text-terracotta' }]} size={124} stroke={11}>
          <p className="font-display text-3xl font-semibold leading-none text-ink">
            {Math.round(application.overall * 100)}
            <span className="text-lg text-ink-soft">%</span>
          </p>
          <p className="mt-1 text-[9px] font-semibold uppercase tracking-[0.15em] text-ink-faint">
            overall
          </p>
        </Halo>
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          {application.streams.map((s) => (
            <div key={s.key}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[10px] font-semibold uppercase tracking-[0.11em] text-ink-faint">
                  {s.label}
                </span>
                <span className="shrink-0 font-display text-base font-semibold leading-none text-ink">
                  {Math.round(s.value * 100)}%
                </span>
              </div>
              <div className="mt-2 flex">
                <Bar value={s.value} fillClassName={s.fill} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ── The list ───────────────────────────────────────────────────────────── */

const RANGE_TONE = {
  Reach: 'text-terracotta-deep',
  Target: 'text-moss',
  Likely: 'text-ink-soft',
};

function SchoolRow({ school }) {
  return (
    <li className="flex items-center gap-5 py-3">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center">
        {school.confirmed ? (
          <CheckCircle2 className="h-[18px] w-[18px] text-moss" strokeWidth={2.2} />
        ) : (
          <CircleDashed className="h-[18px] w-[18px] text-ink-faint" strokeWidth={2.2} />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-ink">
        {school.name}
      </span>
      <span className="w-14 shrink-0 text-right text-[11px] font-bold uppercase tracking-[0.1em] text-ink-faint">
        {school.term}
      </span>
      <span className="flex w-40 shrink-0 items-center gap-3">
        <Bar value={school.pct} />
        <span className="w-9 shrink-0 text-right text-[12px] font-semibold text-ink-soft">
          {Math.round(school.pct * 100)}%
        </span>
      </span>
    </li>
  );
}

export function CollegeList({ colleges, delay = 0 }) {
  return (
    <section className="portal-rise neu-raised rounded-[2.5rem] p-7" style={{ animationDelay: `${delay}ms` }}>
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <Eyebrow>The list</Eyebrow>
        <div className="flex items-baseline gap-7">
          {[
            [colleges.onList, 'on the list'],
            [colleges.confirmed, 'confirmed'],
            [colleges.goal, 'list goal'],
          ].map(([n, label]) => (
            <span key={label} className="flex items-baseline gap-2">
              <span className="font-display text-xl font-semibold leading-none text-ink">{n}</span>
              <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
                {label}
              </span>
            </span>
          ))}
        </div>
      </div>

      {/* Hairline-divided rows, not a card per school: eleven cards would cost
          eleven times the real estate to say the same eleven things. */}
      <div className="mt-5 space-y-5">
        {colleges.groups.map((g) => (
          <div key={g.range}>
            <div className="flex items-center gap-3">
              <Landmark className={`h-4 w-4 ${RANGE_TONE[g.range]}`} strokeWidth={2.1} />
              <span
                className={`text-[11px] font-bold uppercase tracking-[0.16em] ${RANGE_TONE[g.range]}`}
              >
                {g.range}
              </span>
              <span className="h-px flex-1 bg-ink-faint/20" />
            </div>
            <ul className="mt-1 divide-y divide-ink-faint/15">
              {g.schools.map((s) => (
                <SchoolRow key={s.name} school={s} />
              ))}
            </ul>
          </div>
        ))}
      </div>
      <p className="mt-5 text-[12px] text-ink-faint">
        Percentages are supplemental-essay completion for that school.
      </p>
    </section>
  );
}

/* ── Meetings ───────────────────────────────────────────────────────────── */

const HW = {
  done: { icon: CheckCircle2, label: 'Homework done', cls: 'text-moss' },
  partly: { icon: CircleDashed, label: 'Partly done', cls: 'text-terracotta-deep' },
};

export function Meetings({ next, sessions, today, delay = 0 }) {
  return (
    <section className="portal-rise neu-raised rounded-[2.5rem] p-7" style={{ animationDelay: `${delay}ms` }}>
      <Eyebrow>Meetings</Eyebrow>

      {/* Next up — the one forward-looking thing on the board, so it gets the
          only filled surface in the card. */}
      <div className="neu-inset mt-4 flex items-center gap-5 rounded-[1.6rem] p-5">
        <span className="neu-chip flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl text-terracotta">
          <Video className="h-6 w-6" strokeWidth={1.9} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-faint">
            Next up
          </p>
          <p className="mt-1 font-display text-[1.2rem] font-semibold leading-snug text-ink">
            {next.kind} with {next.with}
          </p>
          <p className="mt-1 text-[13px] text-ink-soft">{next.agenda}</p>
        </div>
        <div className="shrink-0 text-right">
          <p className="font-display text-[1.2rem] font-semibold leading-none text-ink">
            {next.when.toFormat('ccc, LLL d')}
          </p>
          <p className="mt-1.5 text-[12px] font-semibold text-ink-soft">
            {next.when.toFormat('h:mm a')} · {next.minutes} min
          </p>
        </div>
      </div>

      <p className="mt-6 text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-faint">
        Recent sessions
      </p>
      <ul className="mt-1 divide-y divide-ink-faint/15">
        {sessions.map((s) => {
          const dt = today.minus({ days: s.d });
          const hw = HW[s.homework] || HW.partly;
          const Icon = hw.icon;
          return (
            <li key={s.d} className="flex items-start gap-5 py-3.5">
              <span className="w-16 shrink-0 pt-0.5 text-[12px] font-bold uppercase tracking-[0.08em] text-ink-faint">
                {dt.toFormat('LLL d')}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[15px] font-semibold text-ink">
                  {s.topic}
                  <span className="ml-2 text-[12px] font-medium text-ink-faint">
                    with {s.with}
                  </span>
                </span>
                <span className="mt-0.5 block text-[13px] leading-relaxed text-ink-soft">
                  {s.note}
                </span>
              </span>
              <span
                className={`flex shrink-0 items-center gap-1.5 pt-0.5 text-[12px] font-semibold ${hw.cls}`}
                title={hw.label}
              >
                <Icon className="h-4 w-4" strokeWidth={2.2} />
                {hw.label}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/* ── Files ──────────────────────────────────────────────────────────────── */

export function FileShelf({ files, today, delay = 0 }) {
  return (
    <section className="portal-rise neu-raised rounded-[2.5rem] p-7" style={{ animationDelay: `${delay}ms` }}>
      <div className="flex items-baseline justify-between gap-4">
        <Eyebrow>Shared files</Eyebrow>
        <span className="text-[11px] font-medium text-ink-faint">
          {files.length} documents, always current
        </span>
      </div>
      <ul className="mt-4 divide-y divide-ink-faint/15">
        {files.map((f) => (
          <li key={f.name} className="flex items-center gap-3 py-3">
            <FileText className="h-[18px] w-[18px] shrink-0 text-terracotta-deep" strokeWidth={2} />
            <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-ink">
              {f.name}
            </span>
            <span className="neu-chip shrink-0 rounded-full px-2.5 py-1.5 text-[10px] font-bold uppercase leading-none tracking-[0.08em] text-ink-soft">
              {f.kind}
            </span>
            <span className="w-14 shrink-0 text-right text-[12px] font-semibold text-ink-faint">
              {today.minus({ days: f.d }).toFormat('LLL d')}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ── The season ─────────────────────────────────────────────────────────── */

export function Season({ today, delay = 0 }) {
  const y = today.month >= 4 ? today.year : today.year - 1;
  const dt = (m, d) => DateTime.fromObject({ year: y, month: m, day: d }, { zone: ZONE });
  const phases = [
    { key: 'summer', label: 'Summer', work: 'Common App main essay + UC PIQs', start: dt(6, 15), end: dt(8, 31) },
    {
      key: 'r1',
      label: 'Round 1',
      work: 'ED · EA · REA supplementals',
      start: dt(9, 1),
      end: dt(10, 15),
      milestones: [{ label: 'List locked', date: dt(9, 1) }],
    },
    {
      key: 'r2',
      label: 'Round 2',
      work: 'ED2 · RD supplementals',
      start: dt(10, 16),
      end: dt(12, 15),
      milestones: [{ label: 'UC applications due', date: dt(12, 1) }],
    },
  ];
  const current = phases.find((p) => today <= p.end.endOf('day'));

  return (
    <section className="portal-rise neu-raised rounded-[2.5rem] p-7" style={{ animationDelay: `${delay}ms` }}>
      <div className="flex items-baseline justify-between gap-4">
        <Eyebrow>The season</Eyebrow>
        <CalendarDays className="h-4 w-4 text-ink-faint" strokeWidth={2} />
      </div>
      <ol className="mt-5">
        {phases.map((p, i) => {
          const done = today > p.end.endOf('day');
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
                <p className="text-[14px] font-semibold text-ink">
                  {p.label}
                  <span className="ml-2 text-[12px] font-medium text-ink-faint">
                    {p.start.toFormat('LLL d')} – {p.end.toFormat('LLL d')}
                  </span>
                </p>
                <p className="mt-0.5 text-[13px] text-ink-soft">{p.work}</p>
                {p.milestones?.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {p.milestones.map((m) => {
                      const passed = today > m.date.endOf('day');
                      const MIcon = passed ? CheckCircle2 : CircleAlert;
                      return (
                        <span
                          key={m.label}
                          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] ${
                            passed ? 'bg-moss/[0.10] text-moss' : 'bg-terracotta/[0.09] text-terracotta-deep'
                          }`}
                        >
                          <MIcon className="h-3 w-3" strokeWidth={2.4} />
                          {m.label}
                          <span className="font-bold tracking-normal">{m.date.toFormat('LLL d')}</span>
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
    </section>
  );
}
