'use client';

import { useEffect, useMemo, useState } from 'react';
import { useDevData } from '../DevDataContext';
import { Badge, Card, Chip, EmptyNote, ErrorNote, PageHeader, SearchInput, TabSkeleton } from '../devUi';
import { formatDateOnly } from '../devFormat';
import { fuzzyMatch } from '../fuzzy';

// Read-only engagement status. Reminder emails are AUTOMATED (the Friday
// checkinReminder.gs run on support@admissions.partners) — this view exists to
// see who that run will hit and why, not to send anything.

const FILTERS = [
  ['flagged', 'All flagged'],
  ['both', 'Missing both'],
  ['ryan', 'Missing Ryan'],
  ['aaron', 'Missing Aaron'],
  ['engaged', 'Engaged'],
  ['excluded', 'Excluded'],
];

function reasonText(side, summer) {
  if (side.engaged) {
    if (side.reasons.includes('checkin'))
      return `Check-in ${side.daysSinceCheckin}d ago`;
    if (side.reasons.includes('recentMeeting'))
      return `Met ${side.daysSinceMeeting}d ago`;
    return `Meeting ${formatDateOnly(side.upcomingMeeting)}`;
  }
  const parts = [
    side.lastCheckin ? `check-in ${side.daysSinceCheckin}d ago` : 'no check-in on record',
  ];
  if (summer) {
    // Meetings shown as context only — they don't count toward summer engagement.
    if (side.upcomingMeeting)
      parts.push(`meeting ${formatDateOnly(side.upcomingMeeting)} (doesn't count in summer)`);
    else if (side.lastMeeting)
      parts.push(`met ${side.daysSinceMeeting}d ago (doesn't count in summer)`);
  } else {
    parts.push(side.lastMeeting ? `last met ${side.daysSinceMeeting}d ago` : 'never met');
    parts.push('nothing upcoming');
  }
  return parts.join(' · ');
}

function InstructorCell({ label, side, summer }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-2">
        <span className="w-12 shrink-0 text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-faint">
          {label}
        </span>
        <Badge tone={side.engaged ? 'moss' : 'accent'}>
          {side.engaged ? 'Engaged' : 'Missing'}
        </Badge>
      </div>
      <p className="mt-1 pl-14 text-[12px] leading-relaxed text-ink-soft">
        {reasonText(side, summer)}
      </p>
    </div>
  );
}

export default function ComplianceTab() {
  const { compliance, ensure, refresh } = useDevData();
  useEffect(() => ensure('compliance'), [ensure]);

  const [filter, setFilter] = useState('flagged');
  const [search, setSearch] = useState('');

  const payload = compliance.data;
  const students = payload?.students || [];

  const counts = useMemo(() => {
    const active = students.filter((s) => !s.excluded);
    return {
      both: active.filter((s) => !s.ryan.engaged && !s.aaron.engaged).length,
      ryan: active.filter((s) => !s.ryan.engaged).length,
      aaron: active.filter((s) => !s.aaron.engaged).length,
      engaged: active.filter((s) => s.ryan.engaged && s.aaron.engaged).length,
      excluded: students.filter((s) => s.excluded).length,
    };
  }, [students]);

  const visible = useMemo(() => {
    const matching = students.filter((s) => fuzzyMatch(search, `${s.name} ${s.email || ''}`));
    const active = matching.filter((s) => !s.excluded);
    switch (filter) {
      case 'flagged':
        return active.filter((s) => !s.ryan.engaged || !s.aaron.engaged);
      case 'both':
        return active.filter((s) => !s.ryan.engaged && !s.aaron.engaged);
      case 'ryan':
        return active.filter((s) => !s.ryan.engaged);
      case 'aaron':
        return active.filter((s) => !s.aaron.engaged);
      case 'engaged':
        return active.filter((s) => s.ryan.engaged && s.aaron.engaged);
      case 'excluded':
        return matching.filter((s) => s.excluded);
      default:
        return active;
    }
  }, [students, filter, search]);

  return (
    <div>
      <PageHeader
        eyebrow={payload?.summerMode ? `Summer · past ${payload?.windowDays ?? 7} days` : `Past ${payload?.windowDays ?? 7} days`}
        title="Compliance"
      >
        <p className="mt-2 max-w-xl text-[13px] leading-relaxed text-ink-soft">
          {payload?.summerMode
            ? 'Who the automated Friday reminder will reach, and why. Summer rules (6/1–8/31): engaged = a weekly check-in only — meetings are as-needed and don’t count.'
            : 'Who the automated Friday reminder will reach, and why. Engaged = a check-in, a recent meeting, or an upcoming meeting with that instructor.'}
        </p>
      </PageHeader>

      {compliance.error ? (
        <ErrorNote message={compliance.error} onRetry={() => refresh('compliance')} />
      ) : !compliance.loaded ? (
        <TabSkeleton rows={6} />
      ) : (
        <>
          {/* Summary stats */}
          <div className="portal-rise mb-5 flex flex-wrap gap-x-8 gap-y-3" style={{ animationDelay: '60ms' }}>
            {[
              ['Missing both', counts.both],
              ['Missing Ryan', counts.ryan],
              ['Missing Aaron', counts.aaron],
              ['Engaged', counts.engaged],
            ].map(([label, value]) => (
              <div key={label}>
                <p className="font-display text-2xl font-semibold leading-none text-ink">{value}</p>
                <p className="mt-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
                  {label}
                </p>
              </div>
            ))}
          </div>

          <div className="portal-rise mb-5 flex flex-wrap items-center gap-2" style={{ animationDelay: '110ms' }}>
            {FILTERS.map(([key, label]) => (
              <Chip key={key} on={filter === key} onClick={() => setFilter(key)}>
                {label}
                {key === 'excluded' && counts.excluded ? ` (${counts.excluded})` : ''}
              </Chip>
            ))}
            <div className="ml-auto">
              <SearchInput
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search student…"
              />
            </div>
          </div>

          {visible.length === 0 ? (
            <Card delay={150}>
              <EmptyNote>
                {filter === 'flagged' ? "Everyone's caught up. 🎉" : 'Nothing matches this view.'}
              </EmptyNote>
            </Card>
          ) : (
            <Card delay={150}>
              <ul className="divide-y divide-sand">
                {visible.map((s) => (
                  <li key={s.email} className="flex flex-col gap-2.5 py-3.5 sm:flex-row sm:items-start sm:gap-6">
                    <div className="w-44 shrink-0">
                      <p className="text-[13px] font-semibold text-ink">{s.name}</p>
                      <p className="truncate text-[11px] text-ink-faint">{s.email}</p>
                      {s.excluded && <Badge tone="muted">Excluded (BE)</Badge>}
                    </div>
                    <InstructorCell label="Ryan" side={s.ryan} summer={payload?.summerMode} />
                    <InstructorCell label="Aaron" side={s.aaron} summer={payload?.summerMode} />
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
