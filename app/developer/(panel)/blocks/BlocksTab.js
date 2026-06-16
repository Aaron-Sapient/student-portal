'use client';

import { useEffect, useState } from 'react';
import { useDevData } from '../DevDataContext';
import {
  Card,
  Chip,
  EmptyNote,
  ErrorNote,
  GhostButton,
  INPUT_CLS,
  PageHeader,
  PillButton,
  TabSkeleton,
} from '../devUi';

export default function BlocksTab() {
  const { blocks, ensure, refresh } = useDevData();
  useEffect(() => ensure('blocks'), [ensure]);

  const [instructor, setInstructor] = useState('aaron');
  const [mode, setMode] = useState('full'); // 'full' = whole day, 'times' = a time window
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!startDate) return;
    if (mode === 'times') {
      if (!startTime || !endTime) {
        alert('Pick a start and end time, or switch to “Full day”.');
        return;
      }
      if (endTime <= startTime) {
        alert('End time must be after start time.');
        return;
      }
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/developer/blocks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instructor,
          startDate,
          endDate: endDate || startDate,
          reason,
          startTime: mode === 'times' ? startTime : '',
          endTime: mode === 'times' ? endTime : '',
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        alert('Add block failed: ' + (data.error || 'unknown'));
        return;
      }
      setStartDate('');
      setEndDate('');
      setStartTime('');
      setEndTime('');
      setReason('');
      await refresh('blocks');
    } finally {
      setSubmitting(false);
    }
  };

  const remove = async (rowIndex) => {
    if (!confirm('Remove this block?')) return;
    const res = await fetch('/api/developer/blocks', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rowIndex }),
    });
    if (!res.ok) {
      const data = await res.json();
      alert('Delete failed: ' + (data.error || 'unknown'));
      return;
    }
    await refresh('blocks');
  };

  return (
    <div>
      <PageHeader eyebrow="Availability" title="Blocks" />

      <Card>
        <div className="mb-4 flex gap-2">
          {[
            ['full', 'Full day'],
            ['times', 'Specific times'],
          ].map(([val, label]) => (
            <Chip key={val} on={mode === val} onClick={() => setMode(val)}>
              {label}
            </Chip>
          ))}
        </div>

        <form onSubmit={submit} className="flex flex-wrap items-center gap-2.5">
          <select
            value={instructor}
            onChange={(e) => setInstructor(e.target.value)}
            className={INPUT_CLS}
          >
            <option value="aaron">Aaron</option>
            <option value="ryan">Ryan</option>
          </select>
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            required
            className={INPUT_CLS}
          />
          <span className="text-[13px] text-ink-faint">to</span>
          <input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className={INPUT_CLS}
          />
          {mode === 'times' && (
            <>
              <input
                type="time"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                required
                className={INPUT_CLS}
              />
              <span className="text-[13px] text-ink-faint">–</span>
              <input
                type="time"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
                required
                className={INPUT_CLS}
              />
            </>
          )}
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason (optional)"
            className={`${INPUT_CLS} min-w-[180px] flex-1`}
          />
          <PillButton type="submit" disabled={submitting}>
            {submitting ? 'Adding…' : 'Add block'}
          </PillButton>
        </form>
      </Card>

      <div className="mt-5">
        {blocks.error ? (
          <ErrorNote message={blocks.error} onRetry={() => refresh('blocks')} />
        ) : !blocks.loaded ? (
          <TabSkeleton rows={3} />
        ) : blocks.data.length === 0 ? (
          <Card delay={150}>
            <EmptyNote>No blocks set.</EmptyNote>
          </Card>
        ) : (
          <Card delay={150}>
            <ul className="divide-y divide-sand">
              {blocks.data.map((b) => (
                <li key={b.rowIndex} className="flex items-center gap-3 py-3 text-[13px]">
                  <span className="w-16 shrink-0 font-semibold capitalize text-ink">
                    {b.instructor}
                  </span>
                  <span className="min-w-0 flex-1 text-ink-soft">
                    {b.startDate}
                    {b.endDate && b.endDate !== b.startDate ? ` → ${b.endDate}` : ''}
                    {b.startTime && b.endTime ? (
                      <span className="text-ink-faint">{`  ·  ${b.startTime}–${b.endTime}`}</span>
                    ) : (
                      <span className="text-ink-faint">{'  ·  all day'}</span>
                    )}
                    {b.reason ? <span className="text-ink-faint"> · {b.reason}</span> : null}
                  </span>
                  <GhostButton onClick={() => remove(b.rowIndex)} className="!px-3 !py-1.5 text-[12px]">
                    Remove
                  </GhostButton>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </div>
  );
}
