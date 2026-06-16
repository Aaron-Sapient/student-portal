'use client';

import { useEffect, useMemo, useState } from 'react';
import { DateTime } from 'luxon';
import { useDevData } from '../DevDataContext';
import {
  Card,
  Chip,
  EmptyNote,
  ErrorNote,
  GhostButton,
  INPUT_CLS,
  Modal,
  PageHeader,
  PillButton,
  SearchInput,
  TabSkeleton,
} from '../devUi';
import { formatPacific, toLocalInputValue } from '../devFormat';

export default function MeetingsTab() {
  const { meetings, ensure, refresh } = useDevData();
  useEffect(() => ensure('meetings'), [ensure]);

  const [busyId, setBusyId] = useState(null);
  const [reschedTarget, setReschedTarget] = useState(null);
  const [reschedValue, setReschedValue] = useState('');

  // Default window: today through 14 days out, in Pacific time, to avoid the
  // off-by-one drift you get if you let the browser do date math in UTC.
  const todayPT = DateTime.now().setZone('America/Los_Angeles').toFormat('yyyy-LL-dd');
  const twoWeeksPT = DateTime.now()
    .setZone('America/Los_Angeles')
    .plus({ days: 14 })
    .toFormat('yyyy-LL-dd');
  const [startDate, setStartDate] = useState(todayPT);
  const [endDate, setEndDate] = useState(twoWeeksPT);
  const [showAaron, setShowAaron] = useState(true);
  const [showRyan, setShowRyan] = useState(true);
  const [show15, setShow15] = useState(true);
  const [show30, setShow30] = useState(true);
  const [search, setSearch] = useState('');

  const all = meetings.data || [];

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const startBound = startDate
      ? DateTime.fromISO(startDate, { zone: 'America/Los_Angeles' }).startOf('day')
      : null;
    const endBound = endDate
      ? DateTime.fromISO(endDate, { zone: 'America/Los_Angeles' }).endOf('day')
      : null;

    return all.filter((m) => {
      const startDt = DateTime.fromISO(m.start).setZone('America/Los_Angeles');
      if (startBound && startDt < startBound) return false;
      if (endBound && startDt > endBound) return false;

      // Instructor: Aaron/Ryan gated on their chip; ART always passes through
      // since the user only asked for the two named instructors.
      const instr = (m.instructor || '').toLowerCase();
      if (instr === 'aaron' && !showAaron) return false;
      if (instr === 'ryan' && !showRyan) return false;

      // Duration: 15min/30min gated on their chip; other durations
      // (email, null, art slots) always pass through.
      if (m.duration === '15min' && !show15) return false;
      if (m.duration === '30min' && !show30) return false;

      if (q) {
        const name = (m.studentName || '').toLowerCase();
        const emailStr = (m.studentEmail || '').toLowerCase();
        if (!name.includes(q) && !emailStr.includes(q)) return false;
      }
      return true;
    });
  }, [all, startDate, endDate, showAaron, showRyan, show15, show30, search]);

  const cancelMeeting = async (m) => {
    if (
      !confirm(
        `Cancel ${m.studentName || m.title} (${m.instructor}) on ${formatPacific(m.start)}? Student will be emailed and their token refunded.`
      )
    )
      return;
    setBusyId(m.id);
    try {
      const res = await fetch('/api/developer/cancelMeeting', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: m.id,
          instructor: m.instructorSlug,
          studentEmail: m.studentEmail,
          studentName: m.studentName,
          meetingStart: m.start,
          duration: m.duration,
        }),
      });
      const data = await res.json();
      if (!res.ok) alert('Cancel failed: ' + (data.error || 'unknown'));
      await refresh('meetings');
    } finally {
      setBusyId(null);
    }
  };

  const openReschedule = (m) => {
    setReschedTarget(m);
    setReschedValue(toLocalInputValue(m.start));
  };

  const submitReschedule = async () => {
    if (!reschedTarget || !reschedValue) return;
    const newStartDt = DateTime.fromISO(reschedValue, { zone: 'America/Los_Angeles' });
    const oldStartDt = DateTime.fromISO(reschedTarget.start);
    const oldEndDt = DateTime.fromISO(reschedTarget.end);
    const durationMin = oldEndDt.diff(oldStartDt, 'minutes').minutes || 30;
    const newEndDt = newStartDt.plus({ minutes: durationMin });

    setBusyId(reschedTarget.id);
    try {
      const res = await fetch('/api/developer/rescheduleMeeting', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: reschedTarget.id,
          instructor: reschedTarget.instructorSlug,
          studentEmail: reschedTarget.studentEmail,
          studentName: reschedTarget.studentName,
          oldStart: reschedTarget.start,
          newStart: newStartDt.toISO(),
          newEnd: newEndDt.toISO(),
        }),
      });
      const data = await res.json();
      if (!res.ok) alert('Reschedule failed: ' + (data.error || 'unknown'));
      setReschedTarget(null);
      await refresh('meetings');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div>
      <PageHeader eyebrow="Calendar admin" title="Meetings" />

      <Card className="mb-5">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className={INPUT_CLS}
            />
            <span className="text-[13px] text-ink-faint">to</span>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className={INPUT_CLS}
            />
          </div>
          <div className="flex items-center gap-2">
            <Chip on={showAaron} onClick={() => setShowAaron((v) => !v)}>
              Aaron
            </Chip>
            <Chip on={showRyan} onClick={() => setShowRyan((v) => !v)}>
              Ryan
            </Chip>
          </div>
          <div className="flex items-center gap-2">
            <Chip on={show15} onClick={() => setShow15((v) => !v)}>
              15min
            </Chip>
            <Chip on={show30} onClick={() => setShow30((v) => !v)}>
              30min
            </Chip>
          </div>
          <div className="ml-auto">
            <SearchInput
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search student…"
            />
          </div>
        </div>
      </Card>

      {meetings.error ? (
        <ErrorNote message={meetings.error} onRetry={() => refresh('meetings')} />
      ) : !meetings.loaded ? (
        <TabSkeleton rows={5} />
      ) : filtered.length === 0 ? (
        <Card delay={150}>
          <EmptyNote>No meetings match the current filters.</EmptyNote>
        </Card>
      ) : (
        <Card delay={150}>
          <ul className="divide-y divide-sand">
            {filtered.map((m) => (
              <li
                key={m.id}
                className="flex flex-col gap-2.5 py-3.5 sm:flex-row sm:items-center sm:gap-4"
              >
                <span className="w-40 shrink-0 text-[13px] font-semibold text-ink">
                  {formatPacific(m.start)}
                </span>
                <span className="w-16 shrink-0 text-[13px] capitalize text-ink-soft">
                  {m.instructor}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="text-[13px] font-medium text-ink">
                    {m.studentName || <span className="text-ink-faint">—</span>}
                  </span>
                  {m.studentEmail && (
                    <span className="block truncate text-[11px] text-ink-faint">
                      {m.studentEmail}
                    </span>
                  )}
                </span>
                <span className="flex shrink-0 gap-2">
                  <GhostButton
                    onClick={() => openReschedule(m)}
                    disabled={busyId === m.id}
                    className="!px-3 !py-1.5 text-[12px]"
                  >
                    Reschedule
                  </GhostButton>
                  <PillButton
                    onClick={() => cancelMeeting(m)}
                    disabled={busyId === m.id}
                    className="!px-3 !py-1.5 text-[12px]"
                  >
                    Cancel
                  </PillButton>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {reschedTarget && (
        <Modal onClose={() => setReschedTarget(null)}>
          <h3 className="font-display text-lg font-semibold text-ink">Reschedule meeting</h3>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-soft">
            {reschedTarget.studentName || reschedTarget.studentEmail || reschedTarget.title}
            <br />
            with {reschedTarget.instructor}
            <br />
            currently {formatPacific(reschedTarget.start)}
          </p>
          <input
            type="datetime-local"
            value={reschedValue}
            onChange={(e) => setReschedValue(e.target.value)}
            className={`${INPUT_CLS} mt-4 w-full`}
          />
          <p className="mt-2 text-[11px] text-ink-faint">
            Admin override: any time accepted. Student will be emailed.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <GhostButton onClick={() => setReschedTarget(null)}>Cancel</GhostButton>
            <PillButton onClick={submitReschedule} disabled={busyId === reschedTarget.id}>
              {busyId === reschedTarget.id ? 'Saving…' : 'Reschedule'}
            </PillButton>
          </div>
        </Modal>
      )}
    </div>
  );
}
