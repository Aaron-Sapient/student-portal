'use client';

import { Bar } from '@/app/(portal)/neu';

// Shared score-display language for the dev Scoring tab and the per-student
// page: the same A/E/L letters, colors, and meta line everywhere.

export const MINI_SUBS = [
  { key: 'academic', letter: 'A', label: 'Academic', fill: 'bg-gradient-to-r from-moss/70 to-moss' },
  { key: 'ec', letter: 'E', label: 'Extracurricular', fill: 'bg-gradient-to-r from-ochre/70 to-ochre' },
  {
    key: 'leadership',
    letter: 'L',
    label: 'Leadership',
    fill: 'bg-gradient-to-r from-terracotta-soft/80 to-terracotta-soft',
  },
];

export function metaLine(latest) {
  return [
    `scored ${latest.date}`,
    latest.model,
    latest.raw?.overall != null ? `raw ${latest.raw.overall}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

// The three A/E/L fill-lines, stacked vertically.
export function SubLines({ latest }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2">
      {MINI_SUBS.map((sub) => {
        const v = latest[sub.key];
        return (
          <div
            key={sub.key}
            className="flex items-center gap-2.5"
            title={`${sub.label} — raw ${latest.raw?.[sub.key] ?? '—'}`}
          >
            <span className="w-3 text-center text-[10px] font-bold uppercase text-ink-faint">
              {sub.letter}
            </span>
            <Bar value={(v ?? 0) / 100} fillClassName={sub.fill} />
            <span className="w-7 shrink-0 text-center text-[11px] font-semibold text-ink">
              {v ?? '—'}
            </span>
          </div>
        );
      })}
    </div>
  );
}
