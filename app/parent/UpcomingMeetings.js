'use client';

import { useEffect, useState } from 'react';
import { CalendarClock } from 'lucide-react';
import { getInstructorPublic } from '@/lib/instructorPublic';
import { cleanAgenda, formatWhen } from '@/app/(portal)/UpcomingMeeting';
import { useParentData } from './ParentDataContext';

// Read-only view of the child's upcoming meetings: who/when/agenda only — no
// cancel, no reschedule, no Zoom link (changes stay student-side). Renders
// NOTHING when no meetings exist (no empty-state cards on Home), and uses a
// per-child localStorage flag so a child known to have meetings gets a
// skeleton instead of content popping in (zero layout shift).
const SHOW_MAX = 3;
const meetingsCacheKey = (sheetId) => `parent:hasMeetings:${sheetId}`;

export default function UpcomingMeetings() {
  const { activeChild } = useParentData();
  const [meetings, setMeetings] = useState(null); // null = loading

  useEffect(() => {
    if (!activeChild) return;
    let alive = true;
    setMeetings(null);
    fetch(`/api/parent/meetings?student=${activeChild.sheetId}`)
      .then((r) => r.json())
      .then((payload) => {
        if (!alive) return;
        const list = payload?.meetings || [];
        setMeetings(list);
        try {
          localStorage.setItem(meetingsCacheKey(activeChild.sheetId), list.length ? '1' : '0');
        } catch {}
      })
      .catch(() => {
        if (alive) setMeetings([]);
      });
    return () => {
      alive = false;
    };
  }, [activeChild]);

  if (!activeChild) return null;

  if (meetings === null) {
    // Skeleton only when this child is known to have meetings — otherwise
    // reserve nothing (most children most weeks: nothing to show).
    let expected = false;
    try {
      expected = localStorage.getItem(meetingsCacheKey(activeChild.sheetId)) === '1';
    } catch {}
    return expected ? <div className="portal-skeleton h-[108px] rounded-3xl" /> : null;
  }

  if (meetings.length === 0) return null;

  return (
    <div className="space-y-2.5">
      {meetings.slice(0, SHOW_MAX).map((m, i) => {
        const inst = getInstructorPublic(m.instructor);
        const agenda = cleanAgenda(m.description);
        return (
          <div key={m.start + m.instructor} className="neu-raised rounded-3xl p-5">
            <div className="flex items-center gap-2">
              <CalendarClock className="h-4 w-4 text-terracotta" strokeWidth={2.2} />
              <span className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-soft">
                {i === 0 ? 'Next meeting' : 'Upcoming'}
              </span>
            </div>
            <p className="mt-3 font-display text-lg font-semibold leading-snug text-ink">
              {(activeChild.name || '').trim().split(' ')[0]} · {inst.bodyName}
            </p>
            <p className="mt-0.5 text-sm text-ink-soft">
              {formatWhen(new Date(m.start), new Date(m.end))}
            </p>
            {agenda && (
              <p className="neu-inset mt-3 rounded-2xl px-3.5 py-2.5 text-sm text-ink-soft">
                <span className="font-semibold text-ink">Agenda · </span>
                {agenda}
              </p>
            )}
          </div>
        );
      })}
      {meetings.length > SHOW_MAX && (
        <p className="px-1 text-xs text-ink-faint">
          +{meetings.length - SHOW_MAX} more scheduled
        </p>
      )}
    </div>
  );
}
