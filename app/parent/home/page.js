'use client';

import { useState } from 'react';
import { DateTime } from 'luxon';
import { CircleAlert, Rocket, Sun } from 'lucide-react';
import { useParentData } from '../ParentDataContext';
import UpcomingMeetings from '../UpcomingMeetings';
import { SectionDial } from '@/app/(portal)/neu';
import {
  GaugeCluster,
  ScoreReadout,
  ProgressLine,
  Projects,
} from '@/app/(portal)/homeSections';
import { ZONE } from '@/app/(portal)/portalUtils';

const SECTIONS = [
  { key: 'today', label: 'Today', icon: Sun },
  { key: 'projects', label: 'Projects', icon: Rocket },
];

function Skeleton() {
  return (
    <div className="space-y-7">
      <div>
        <div className="portal-skeleton h-3 w-40 rounded-full" />
        <div className="portal-skeleton mt-3 h-11 w-64 rounded-2xl" />
      </div>
      <div className="portal-skeleton mx-auto h-16 w-full max-w-sm rounded-full" />
      <div className="portal-skeleton h-[380px] rounded-[2.5rem]" />
      <div className="space-y-2.5">
        <div className="portal-skeleton h-[60px] rounded-2xl" />
        <div className="portal-skeleton h-[60px] rounded-2xl" />
      </div>
    </div>
  );
}

export default function ParentHomePage() {
  const { activeChild, data, loading, error } = useParentData();
  const [section, setSection] = useState('today');

  if (loading || !activeChild) return <Skeleton />;

  if (error) {
    return (
      <div className="portal-rise mt-10 rounded-3xl border border-terracotta/25 bg-clay-50 p-6 text-center">
        <CircleAlert className="mx-auto h-7 w-7 text-terracotta" strokeWidth={2} />
        <p className="mt-3 font-display text-lg font-semibold text-ink">Something’s off</p>
        <p className="mt-1 text-sm text-ink-soft">{error}</p>
      </div>
    );
  }

  const first =
    (data.studentName || activeChild.name || '').trim().split(' ')[0] || 'your student';
  const today = DateTime.now().setZone(ZONE).toFormat('cccc, LLLL d');

  return (
    // Keyed on the child so the staggered rise replays on switch.
    <div key={activeChild.sheetId} className="space-y-7">
      <header className="portal-rise" style={{ animationDelay: '0ms' }}>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-ink-faint">{today}</p>
        <h1 className="mt-1.5 font-display text-[2rem] font-semibold leading-[1.08] tracking-tight text-ink sm:text-[2.6rem] sm:leading-[1.05]">
          Here’s how
          <br />{' '}
          <span className="text-terracotta">{first}</span> is doing.
        </h1>
      </header>

      <div className="portal-rise" style={{ animationDelay: '50ms' }}>
        <SectionDial sections={SECTIONS} value={section} onChange={setSection} />
      </div>

      {/* Keyed so each section replays the staggered rise on switch. */}
      <div key={section}>
        {section === 'today' && (
          <div className="space-y-5">
            <GaugeCluster scores={data.scores} />
            {/* View-only: parents see meetings, never reschedule/cancel them. */}
            <UpcomingMeetings />
            <ProgressLine progress={data.progress} />
            <ScoreReadout scores={data.scores} />
          </div>
        )}
        {section === 'projects' && <Projects data={data} />}
      </div>
    </div>
  );
}
