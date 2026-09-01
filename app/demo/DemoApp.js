'use client';

import { useState } from 'react';
import { CalendarDays, Compass, Landmark, ListTodo, PenLine } from 'lucide-react';
import { Colleges, Meetings, Overview, Plan, Writing } from './sections';

/* The demo shell: a persistent left rail plus one section at a time.

   Why a rail and not a top pill. The showmanship here is Ryan clicking through
   the portal while he talks, so navigation is the thing being demonstrated and
   it has to stay on screen the whole time. On a 1920x1080 TV, horizontal space
   is the surplus and vertical space is the scarce resource, so a rail spends
   the cheap axis and a top bar would spend the expensive one. A rail also shows
   current location permanently, which a parent watching from across a room
   needs more than the presenter does, and it makes the page read as software
   somebody logs into rather than as one long printed sheet.

   Five destinations, which is the working-memory ceiling for a top level.
   Every item carries an icon AND a word: icon-only rails are unreadable to a
   first-time viewer, and this viewer is always a first-time viewer.

   Switching is useState over data already in memory. No route change, no
   fetch, no suspense boundary, no skeleton: there is no state between clicking
   and seeing, which is the only guarantee that nothing can crumble mid-sentence. */

const SECTIONS = [
  { key: 'overview', label: 'Overview', icon: Compass, View: Overview },
  { key: 'colleges', label: 'College list', icon: Landmark, View: Colleges },
  { key: 'meetings', label: 'Meetings', icon: CalendarDays, View: Meetings },
  { key: 'writing', label: 'Essays and files', icon: PenLine, View: Writing },
  { key: 'plan', label: 'The plan', icon: ListTodo, View: Plan },
];

export default function DemoApp({ data, initial }) {
  const [active, setActive] = useState(
    SECTIONS.some((s) => s.key === initial) ? initial : 'overview'
  );
  const current = SECTIONS.find((s) => s.key === active) || SECTIONS[0];
  const View = current.View;

  return (
    <div className="demo-board mx-auto flex w-full max-w-[1560px] flex-col gap-8 px-8 py-12 lg:flex-row lg:gap-10 xl:px-12">
      {/* Below the rail's breakpoint the same five destinations become a
          horizontal row rather than disappearing. Hiding the only navigation on
          a narrow screen leaves every section but the first unreachable, which
          is a dead end rather than a simplification. */}
      <div className="h-fit shrink-0 lg:sticky lg:top-10 lg:w-[15.5rem]">
        <h1 className="font-display text-[1.6rem] font-semibold leading-tight tracking-tight text-ink">
          {data.student.name}
        </h1>
        <p className="mt-1.5 text-[14px] font-medium text-ink-soft">
          {data.student.year}, class of {data.student.gradYear}
        </p>
        <p className="text-[14px] text-ink-soft">{data.student.school}</p>

        <nav
          aria-label="Portal sections"
          className="mt-6 flex flex-row gap-1.5 overflow-x-auto pb-1 lg:mt-8 lg:flex-col lg:overflow-visible lg:pb-0"
        >
          {SECTIONS.map(({ key, label, icon: Icon }) => {
            const on = key === active;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setActive(key)}
                aria-current={on ? 'page' : undefined}
                className={`demo-nav-item flex shrink-0 items-center gap-3.5 rounded-2xl px-4 py-3 text-left text-[15px] font-semibold transition-colors duration-150 ${
                  on
                    ? 'neu-raised text-terracotta-deep'
                    : 'text-ink-soft hover:bg-ink/[0.04] hover:text-ink'
                }`}
              >
                <Icon className="h-[19px] w-[19px] shrink-0" strokeWidth={on ? 2.3 : 2} />
                {label}
              </button>
            );
          })}
        </nav>

        <dl className="mt-9 hidden border-t border-ink-faint/25 pt-6 text-[14px] lg:block">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-ink-soft">Counselor</dt>
            <dd className="font-semibold text-ink">{data.student.counselor}</dd>
          </div>
          <div className="mt-2 flex items-baseline justify-between gap-3">
            <dt className="text-ink-soft">Essay coach</dt>
            <dd className="font-semibold text-ink">{data.student.essayCoach}</dd>
          </div>
          <p className="mt-5 text-[13px] text-ink-soft">Updated {data.todayLabel}</p>
        </dl>
      </div>

      <main className="min-w-0 flex-1">
        <View data={data} />

        {/* Honesty marker, deliberately the quietest thing on screen: the room
            is told out loud that this is a sample, so this only has to survive
            a screenshot leaving the room. Delete this one element to remove it. */}
        <p className="mt-14 text-[13px] text-ink-soft">Sample portal. Fictional student.</p>
      </main>
    </div>
  );
}
