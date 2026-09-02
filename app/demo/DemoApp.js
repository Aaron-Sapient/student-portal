'use client';

import { useState } from 'react';
import { CalendarDays, Compass, Landmark, ListTodo, PenLine } from 'lucide-react';
import { Colleges, Meetings, Overview, Plan, Writing } from './sections';

/* The demo shell: a razor-thin icon rail plus one section at a time.

   Why a rail and not a top bar. The showmanship here is Ryan clicking through
   the portal while he talks, so navigation is the thing being demonstrated and
   it has to stay on screen the whole time. On a 1920x1080 TV horizontal space is
   the surplus and vertical space is the scarce resource, so a rail spends the
   cheap axis. Stripped to icons it costs 4.5rem, which is close to free.

   Five destinations, the working-memory ceiling for a top level. Each carries an
   aria-label and a tooltip on hover and on keyboard focus; the current section is
   marked by the icon's own colour and a hairline indicator, not by a filled pill,
   so the rail stays quiet while the content carries the page.

   Switching is useState over data already in memory. No route change, no fetch,
   no suspense boundary, no skeleton: nothing between the click and the render
   that could crumble mid-sentence. */

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
  const View = (SECTIONS.find((s) => s.key === active) || SECTIONS[0]).View;

  return (
    <div className="demo-board mx-auto flex w-full max-w-[1560px] flex-col gap-6 px-8 py-10 min-[1025px]:flex-row min-[1025px]:gap-9 xl:px-12">
      {/* Below the rail's breakpoint the same five destinations become a
          horizontal strip rather than disappearing. Hiding the only navigation
          leaves four of five sections unreachable, which is a dead end. */}
      <nav
        aria-label="Portal sections"
        className="demo-rail flex shrink-0 flex-row gap-1 min-[1025px]:sticky min-[1025px]:top-10 min-[1025px]:h-fit min-[1025px]:w-[4.5rem] min-[1025px]:flex-col min-[1025px]:gap-2"
      >
        {SECTIONS.map(({ key, label, icon: Icon }) => {
          const on = key === active;
          return (
            <button
              key={key}
              type="button"
              onClick={() => setActive(key)}
              aria-label={label}
              aria-current={on ? 'page' : undefined}
              className={`demo-nav-item ${on ? 'is-on' : ''}`}
            >
              <Icon className="h-[22px] w-[22px]" strokeWidth={on ? 2.2 : 1.9} aria-hidden />
              <span className="demo-tip" role="tooltip">
                {label}
              </span>
            </button>
          );
        })}
      </nav>

      <main className="min-w-0 flex-1">
        {/* Whose portal this is. Small, quiet, ruled off, and identical on every
            section, so the room never has to remember which student is on
            screen and no section has to spend a headline saying it. */}
        <header className="mb-8 flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-ink-faint/25 pb-4">
          <span className="font-display text-[1.15rem] font-semibold leading-none text-ink">
            {data.student.name}
          </span>
          <span className="text-[14px] text-ink-soft">
            {data.student.year}, class of {data.student.gradYear}
          </span>
          <span className="text-[14px] text-ink-soft">{data.student.school}</span>
        </header>

        <View data={data} />

        {/* Honesty marker, deliberately the quietest thing on screen: the room is
            told out loud that this is a sample, so this only has to survive a
            screenshot leaving the room. Delete this one element to remove it. */}
        <p className="mt-14 text-[13px] text-ink-soft">Sample portal. Fictional student.</p>
      </main>
    </div>
  );
}
