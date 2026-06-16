'use client';

import { useState } from 'react';
import { DateTime } from 'luxon';
import { CircleAlert, Rocket, Sun, Video } from 'lucide-react';
import { usePortalData } from '../PortalDataContext';
import CoachCard from '../CoachCard';
import { ClayBloom, PointerRow, SectionDial } from '../neu';
import { GaugeCluster, ScoreReadout, ProgressLine, Projects } from '../homeSections';
import { ZONE } from '../portalUtils';

const SECTIONS = [
  { key: 'today', label: 'Today', icon: Sun },
  { key: 'projects', label: 'Projects', icon: Rocket },
];

/* ── Today: conditional pointer rows (the only text containers) ─────────── */

function fmtMeeting(m) {
  const dt = DateTime.fromJSDate(new Date(m.start)).setZone(ZONE);
  const min = dt.minute === 0 ? '' : `:${dt.toFormat('mm')}`;
  return `${dt.toFormat('ccc, LLL d')} · ${dt.toFormat('h')}${min} ${dt.toFormat('a').toLowerCase()}`;
}

// NOTE: no check-in or booking rows here on purpose — the tab-bar notification
// dots carry those signals (info-once rule). The only pointer left is the next
// booked meeting; nothing booked → nothing rendered.
function NextMeetingRow({ meetings }) {
  const next = meetings[0];
  if (!next) return null;
  return (
    <PointerRow
      icon={Video}
      label={fmtMeeting(next)}
      sub={`Next meeting · ${next.instructor}`}
      href="/meetings"
      delay={170}
    />
  );
}

function Today({ data, meetings, coach }) {
  // Rhythm: gauges → next meeting → project progress → the readout text, last.
  // (Session frequency lives in the Meetings tab — its perfect place.)
  return (
    <div className="space-y-5">
      {/* Claude Coach — warm, time-sensitive note (shows only when present) */}
      <CoachCard coach={coach} />
      <GaugeCluster scores={data.scores} />
      <NextMeetingRow meetings={meetings} />
      <ProgressLine progress={data.progress} />
      <ScoreReadout scores={data.scores} />
    </div>
  );
}

/* ── Page ───────────────────────────────────────────────────────────────── */

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

export default function HomePage() {
  const { data, meetings, coach, loading, error } = usePortalData();
  const [section, setSection] = useState('today');

  if (loading) return <Skeleton />;

  if (error) {
    return (
      <div className="portal-rise mt-10 rounded-3xl border border-terracotta/25 bg-clay-50 p-6 text-center">
        <CircleAlert className="mx-auto h-7 w-7 text-terracotta" strokeWidth={2} />
        <p className="mt-3 font-display text-lg font-semibold text-ink">Something’s off</p>
        <p className="mt-1 text-sm text-ink-soft">{error}</p>
      </div>
    );
  }

  const first = (data.studentName || '').trim().split(' ')[0] || 'there';
  const today = DateTime.now().setZone(ZONE).toFormat('cccc, LLLL d');

  return (
    <div className="space-y-7">
      {/* Greeting */}
      {/* Phones get a tighter gap and smaller display type — at 2.6rem next to
          the glyph the heading nearly touches the screen edge. sm+ is untouched. */}
      <header className="portal-rise flex items-center gap-4 sm:gap-5" style={{ animationDelay: '0ms' }}>
        <ClayBloom scale={1.25} />
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-ink-faint">{today}</p>
          <h1 className="mt-1.5 font-display text-[2rem] font-semibold leading-[1.08] tracking-tight text-ink sm:text-[2.6rem] sm:leading-[1.05]">
            Welcome back,
            <br />{' '}
            <span className="text-terracotta">{first}.</span>
          </h1>
        </div>
      </header>

      <div className="portal-rise" style={{ animationDelay: '50ms' }}>
        <SectionDial sections={SECTIONS} value={section} onChange={setSection} />
      </div>

      {/* Keyed so each section replays the staggered rise on switch. */}
      <div key={section}>
        {section === 'today' && <Today data={data} meetings={meetings} coach={coach} />}
        {section === 'projects' && <Projects data={data} />}
      </div>
    </div>
  );
}
