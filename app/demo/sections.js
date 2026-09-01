'use client';

import {
  CalendarCheck,
  CheckCircle2,
  CircleAlert,
  CircleDashed,
  FileText,
  Video,
} from 'lucide-react';
import { Bar, Halo } from '@/app/(portal)/neu';
import { GaugeCluster, ScoreReadout } from '@/app/(portal)/homeSections';

/* Demo-only sections. Presentational, no hooks, no fetch: every value arrives
   as plain JSON already formatted by app/demo/demoData.js, which is what lets
   the sidebar switch sections with nothing to load and nothing to flash.

   Card titles are real headings, not all-caps kickers over a heading. The
   heading level is honest too: h1 in the sidebar identity, h2 per section, h3
   per card, so the outline reads correctly to a screen reader. */

/* ── Shared shells ──────────────────────────────────────────────────────── */

export function SectionHead({ title, sub }) {
  return (
    <header className="mb-8">
      <h2 className="font-display text-[2.5rem] font-semibold leading-[1.05] tracking-tight text-ink">
        {title}
      </h2>
      {sub && <p className="mt-3 max-w-[68ch] text-[16px] leading-relaxed text-ink-soft">{sub}</p>}
    </header>
  );
}

function Card({ title, sub, aside, children, className = '' }) {
  return (
    <section className={`neu-raised rounded-[2.5rem] p-7 ${className}`}>
      {(title || aside) && (
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
          {title && (
            <h3 className="font-display text-[1.3rem] font-semibold leading-snug text-ink">
              {title}
            </h3>
          )}
          {aside && <span className="text-[13px] font-medium text-ink-soft">{aside}</span>}
        </div>
      )}
      {sub && <p className="mt-1.5 max-w-[68ch] text-[14px] leading-relaxed text-ink-soft">{sub}</p>}
      <div className={title || sub ? 'mt-5' : ''}>{children}</div>
    </section>
  );
}

function GroupRule({ label, tone, note }) {
  return (
    <div className="mb-1 mt-6 first:mt-0">
      <div className="flex items-center gap-3">
        <span className={`text-[15px] font-semibold ${tone}`}>{label}</span>
        <span className="h-px flex-1 bg-ink-faint/25" />
      </div>
      {note && <p className="mt-1.5 text-[13px] leading-relaxed text-ink-soft">{note}</p>}
    </div>
  );
}

function StatusDot({ on, onLabel, offLabel }) {
  const Icon = on ? CheckCircle2 : CircleDashed;
  return (
    <span
      className={`flex shrink-0 items-center gap-2 text-[13px] font-semibold ${
        on ? 'text-moss' : 'text-ink-soft'
      }`}
    >
      <Icon className="h-[18px] w-[18px]" strokeWidth={2.2} />
      {on ? onLabel : offLabel}
    </span>
  );
}

/* ── 1. Overview ────────────────────────────────────────────────────────── */

export function Overview({ data }) {
  const m = data.nextMeeting;
  const move = data.scores.latest.overall - data.scores.prev.overall;
  return (
    <>
      <SectionHead title={`Here’s how ${data.student.first} is doing.`} />

      {/* Two columns from 960 up, because 960 is a real viewport here: Ryan runs
          this at half screen beside a university site. Stacked, the gauge card
          spans the full width and throws its own labels 600px away from their
          numbers. `min-[960px]` rather than `md`, because at 768 the five-column
          gauge is too narrow for the component's own sub-score labels. */}
      <div className="row-tie grid grid-cols-1 gap-6 min-[960px]:grid-cols-12">
        <div className="card-hero card-fill min-[960px]:col-span-6 min-[1400px]:col-span-5">
          <GaugeCluster scores={data.scores} />
        </div>
        <div className="card-read min-[960px]:col-span-6 min-[1400px]:col-span-7">
          <ScoreReadout scores={data.scores} />
        </div>
      </div>

      {/* 79 of what? The product never has to answer that, because a student
          checking their own standing already knows. A parent seeing the number
          once, from across a room, does not. */}
      <p className="mt-5 max-w-[76ch] text-[15px] leading-relaxed text-ink-soft">
        The Choice Score is out of 100, weighing academics, activities and leadership against
        the schools actually on {data.student.first}’s list. It is up {move} points since the
        last check-in.
      </p>

      {/* A pointer, not a second copy: the meeting lives in Meetings. */}
      <p className="mt-4 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[15px] text-ink-soft">
        <CalendarCheck
          className="relative top-[3px] h-[18px] w-[18px] shrink-0 text-terracotta-deep"
          strokeWidth={2.1}
        />
        <span>
          Next up, <span className="font-semibold text-ink">{m.kind.toLowerCase()} with {m.who}</span>,{' '}
          {m.dayLabel} at {m.timeLabel}.
        </span>
      </p>
    </>
  );
}

/* ── 2. College list ────────────────────────────────────────────────────── */

const RANGE_TONE = {
  Reach: 'text-terracotta-deep',
  Target: 'text-moss',
  Likely: 'text-ink-soft',
};

function SchoolRow({ school }) {
  /* One line on the wide surface this page is built for. Below that the fixed
     meta columns add up to more than the row has, and the school name is the
     column that gives, collapsing to a single letter. So the meta drops to its
     own line and the name keeps its width. `lg:contents` puts the four meta
     cells back into the row's own flex context at desktop width, so there is
     one markup path rather than two. */
  return (
    <li className="py-3.5 lg:flex lg:items-center lg:gap-4">
      <span className="block truncate text-[16px] font-semibold text-ink lg:min-w-0 lg:flex-1">
        {school.name}
      </span>
      <span className="mt-1.5 flex items-center gap-4 lg:mt-0 lg:contents">
        <span className="w-[10rem] shrink-0 text-[13px] font-semibold text-ink-soft">
          {school.term}
        </span>
        <span className="w-[5.5rem] shrink-0 text-[13px] font-medium text-ink-soft">
          Due {school.due}
        </span>
        <span className="flex w-[7.5rem] shrink-0 items-center gap-2.5">
          <Bar value={school.pct} />
          <span className="w-10 shrink-0 text-right text-[13px] font-semibold text-ink-soft">
            {Math.round(school.pct * 100)}%
          </span>
        </span>
        <span className="w-[6.5rem] shrink-0">
          <StatusDot on={school.confirmed} onLabel="Confirmed" offLabel="Deciding" />
        </span>
      </span>
    </li>
  );
}

export function Colleges({ data }) {
  const c = data.colleges;
  return (
    <>
      <SectionHead
        title={`${data.student.first}’s college list`}
        sub={`${c.onList} schools, ${c.confirmed} confirmed. Reach, target and likely, with the supplemental essay for each one tracked on its own bar.`}
      />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <div className="lg:col-span-8">
          <Card>
            {c.groups.map((g) => (
              <div key={g.range}>
                <GroupRule label={g.range} tone={RANGE_TONE[g.range]} note={g.note} />
                <ul className="divide-y divide-ink-faint/15">
                  {g.schools.map((s) => (
                    <SchoolRow key={s.name} school={s} />
                  ))}
                </ul>
              </div>
            ))}
          </Card>
        </div>
        <div className="lg:col-span-4">
          <ApplicationCard application={data.application} />
        </div>
      </div>
    </>
  );
}

function ApplicationCard({ application }) {
  return (
    <section className="neu-raised rounded-[2.5rem] p-7">
      <div className="flex items-baseline justify-between gap-4">
        <h3 className="font-display text-[1.3rem] font-semibold leading-snug text-ink">
          Application progress
        </h3>
        <span className="font-display text-[1.6rem] font-semibold leading-none text-ink">
          {Math.round(application.overall * 100)}%
        </span>
      </div>
      <div className="mt-4 flex max-w-[34rem]">
        <Bar value={application.overall} />
      </div>
      <p className="mt-3 text-[13px] leading-relaxed text-ink-soft">
        Round 1 opens the supplemental essays, which is where most of the remaining work sits.
      </p>
      <div className="mt-6 flex max-w-[34rem] flex-col gap-4 border-t border-ink-faint/20 pt-5">
        {application.streams.map((st) => (
          <div key={st.key}>
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[13px] font-semibold text-ink-soft">{st.label}</span>
              <span className="shrink-0 font-display text-base font-semibold leading-none text-ink">
                {Math.round(st.value * 100)}%
              </span>
            </div>
            <div className="mt-2 flex">
              <Bar value={st.value} fillClassName={st.fill} />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ── 3. Meetings ────────────────────────────────────────────────────────── */

const HW = {
  done: { icon: CheckCircle2, label: 'Homework done', cls: 'text-moss' },
  partly: { icon: CircleDashed, label: 'Partly done', cls: 'text-terracotta-deep' },
};

export function Meetings({ data }) {
  const m = data.nextMeeting;
  return (
    <>
      <SectionHead
        title="Every meeting, logged"
        sub="Forty five minutes a week with Aaron on the writing, plus a strategy session with Ryan each month. What was covered and what was assigned is written down after every one."
      />

      {/* Next up is its own card rather than a card nested inside the log. */}
      <section className="neu-raised mb-6 flex flex-wrap items-center gap-x-8 gap-y-5 rounded-[2.5rem] p-7">
        <span className="neu-chip flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl text-terracotta">
          <Video className="h-7 w-7" strokeWidth={1.9} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="font-display text-[1.6rem] font-semibold leading-snug text-ink">
            {m.kind} with {m.who}
          </h3>
          <p className="mt-1 text-[15px] text-ink-soft">{m.agenda}</p>
        </div>
        <div className="shrink-0 text-right">
          <p className="font-display text-[1.4rem] font-semibold leading-none text-ink">
            {m.dayLabel}
          </p>
          <p className="mt-2 text-[14px] font-semibold text-ink-soft">
            {m.timeLabel}, {m.minutes} minutes
          </p>
        </div>
      </section>

      <Card title="Recent sessions" aside={`${data.sessions.length} logged this term`}>
        <ul className="divide-y divide-ink-faint/15">
          {data.sessions.map((s) => {
            const hw = HW[s.homework] || HW.partly;
            const Icon = hw.icon;
            return (
              <li key={s.id} className="flex items-start gap-6 py-4">
                <span className="w-20 shrink-0 pt-1 text-[14px] font-semibold text-ink-soft">
                  {s.dateLabel}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[16px] font-semibold text-ink">
                    {s.topic}
                    <span className="ml-2.5 text-[13px] font-medium text-ink-soft">
                      with {s.who}
                    </span>
                  </span>
                  <span className="mt-1 block max-w-[68ch] text-[14px] leading-relaxed text-ink-soft">
                    {s.note}
                  </span>
                </span>
                <span
                  className={`flex w-[9.5rem] shrink-0 items-center gap-2 pt-1 text-[13px] font-semibold ${hw.cls}`}
                >
                  <Icon className="h-[18px] w-[18px]" strokeWidth={2.2} />
                  {hw.label}
                </span>
              </li>
            );
          })}
        </ul>
      </Card>
    </>
  );
}

/* ── 4. Essays and files ────────────────────────────────────────────────── */

export function Writing({ data }) {
  return (
    <>
      <SectionHead
        title="Essays, draft by draft"
        sub={`${data.essays.length} pieces of writing in flight. Every draft is saved here as it is written, so you can read what she is working on without asking for it.`}
      />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <div className="lg:col-span-7">
          <Card title="In progress">
            <ul className="divide-y divide-ink-faint/15">
              {data.essays.map((e) => (
                <li key={e.id} className="py-4">
                  <div className="flex items-baseline justify-between gap-5">
                    <span className="min-w-0 text-[16px] font-semibold text-ink">{e.name}</span>
                    <span className="shrink-0 text-[13px] font-medium text-ink-soft">{e.round}</span>
                  </div>
                  <div className="mt-2.5 flex items-center gap-4">
                    <span className="w-44 shrink-0 text-[14px] text-ink-soft">{e.stage}</span>
                    <Bar value={e.pct} />
                    <span className="w-10 shrink-0 text-right text-[13px] font-semibold text-ink-soft">
                      {Math.round(e.pct * 100)}%
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        </div>
        <div className="lg:col-span-5">
          <Card title="Shared files" aside={`${data.files.length} documents`}>
            <ul className="divide-y divide-ink-faint/15">
              {data.files.map((f) => (
                <li key={f.id} className="flex items-center gap-3 py-3.5">
                  <FileText
                    className="h-[18px] w-[18px] shrink-0 text-terracotta-deep"
                    strokeWidth={2}
                  />
                  <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-ink">
                    {f.name}
                  </span>
                  <span className="shrink-0 text-[12px] font-semibold text-ink-soft">{f.kind}</span>
                  <span className="w-14 shrink-0 text-right text-[13px] font-medium text-ink-soft">
                    {f.dateLabel}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}

/* ── 5. The plan ────────────────────────────────────────────────────────── */

export function Plan({ data }) {
  return (
    <>
      <SectionHead
        title="The plan for senior year"
        sub="The course plan, the activities that actually carry the application, and where we are in the admissions season."
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <div className="lg:col-span-5">
          <Card title="Course plan" sub={data.coursePlan.summary}>
            <ul className="divide-y divide-ink-faint/15">
              {data.coursePlan.courses.map((c) => (
                <li key={c.id} className="flex items-baseline gap-4 py-3.5">
                  <span className="w-[4.5rem] shrink-0 text-[13px] font-semibold text-ink-soft">
                    {c.tag}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[15px] font-semibold text-ink">{c.name}</span>
                    <span className="mt-0.5 block text-[13px] leading-relaxed text-ink-soft">
                      {c.why}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </div>

        <div className="lg:col-span-7">
          <Card title="Activities and projects">
            <ul className="divide-y divide-ink-faint/15">
              {data.projects.map((p) => (
                <li key={p.id} className="py-4">
                  <div className="flex items-baseline justify-between gap-5">
                    <span className="min-w-0 text-[16px] font-semibold text-ink">{p.name}</span>
                    <span className="shrink-0 text-[13px] font-medium text-ink-soft">{p.role}</span>
                  </div>
                  <p className="mt-1 text-[14px] leading-relaxed text-ink-soft">{p.detail}</p>
                  <div className="mt-2.5 flex items-center gap-4">
                    <Bar value={p.pct} />
                    <span className="w-10 shrink-0 text-right text-[13px] font-semibold text-ink-soft">
                      {Math.round(p.pct * 100)}%
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>

      <div className="mt-6">
        <Card title="The season">
          <ol className="grid grid-cols-1 gap-6 md:grid-cols-3">
            {data.phases.map((p) => (
              <li key={p.key}>
                <div className="flex items-center gap-3">
                  {p.done ? (
                    <CheckCircle2 className="h-[18px] w-[18px] text-moss" strokeWidth={2.4} />
                  ) : p.live ? (
                    <span className="neu-pulse h-3.5 w-3.5 rounded-full bg-terracotta" />
                  ) : (
                    <span className="h-3.5 w-3.5 rounded-full border-2 border-ink-soft/50" />
                  )}
                  <span className="text-[16px] font-semibold text-ink">{p.name}</span>
                  <span className="text-[13px] font-medium text-ink-soft">{p.range}</span>
                </div>
                {p.current && (
                  <p className="mt-1.5 pl-[30px] text-[14px] font-semibold text-terracotta-deep">
                    {p.live ? 'Here now' : 'Up next'}
                  </p>
                )}
                <p className="mt-2 pl-[30px] text-[14px] leading-relaxed text-ink-soft">{p.work}</p>
                {p.milestone && (
                  <p
                    className={`mt-2.5 ml-[30px] inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-[12px] font-semibold ${
                      p.milestone.passed
                        ? 'bg-moss/[0.12] text-moss'
                        : 'bg-terracotta/[0.10] text-terracotta-deep'
                    }`}
                  >
                    {p.milestone.passed ? (
                      <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={2.4} />
                    ) : (
                      <CircleAlert className="h-3.5 w-3.5" strokeWidth={2.4} />
                    )}
                    {p.milestone.name}, {p.milestone.date}
                  </p>
                )}
              </li>
            ))}
          </ol>
        </Card>
      </div>
    </>
  );
}
