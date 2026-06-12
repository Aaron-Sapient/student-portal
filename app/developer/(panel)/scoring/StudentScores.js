'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronRight } from 'lucide-react';
import { Halo } from '@/app/(portal)/neu';
import { gradeFromClass } from '@/lib/scores';
import { useDevData } from '../DevDataContext';
import { fuzzyMatch, studentHaystack } from '../fuzzy';
import { Badge, Card, EmptyNote, ErrorNote, SearchInput, TabSkeleton } from '../devUi';
import { metaLine, SubLines } from './scoreUi';

// The fuzzy-searchable roster of latest scores. Rendered under the params
// editor on /developer/scoring and as its own Students tab on /dev.

// Desktop (sm+): the original three-column row — wheel | name+insight | A/E/L.
// Mobile: the wheel+name header keeps row one, then the insight and the A/E/L
// lines each take the full card width below (no orphaned bottom-right gap).
// The whole row links to the student's page (slug = sheet id), relative to the
// current path so the list works from both /developer/scoring and /dev/students.
function ScoreRow({ student }) {
  const base = usePathname() || '/developer/scoring';
  const { latest, stale } = student;
  const insightCls = 'font-display text-[13px] leading-snug text-ink-soft';
  return (
    <Link
      href={`${base}/${student.sheetId}`}
      className="grid w-full grid-cols-[auto_1fr_auto] items-center gap-x-4 gap-y-3 border-t border-sand py-4 text-left transition-opacity first:border-t-0 active:opacity-70 sm:grid-cols-[auto_1fr_11rem_auto] sm:gap-x-5"
    >
      <Halo
        rings={[{ value: (latest.overall ?? 0) / 100, className: 'text-terracotta' }]}
        size={84}
        stroke={15}
      >
        <p className="font-display text-xl font-semibold leading-none text-ink">
          {latest.overall ?? '—'}
        </p>
      </Halo>

      <div className="min-w-0">
        <div className="flex items-baseline gap-2">
          <h3 className="truncate font-display text-[15px] font-semibold text-ink">
            {student.name}
          </h3>
          {student.grade && (
            <span className="shrink-0 text-[11px] font-medium text-ink-faint">{student.grade}</span>
          )}
          {stale && <Badge tone="ochre">Stale</Badge>}
        </div>
        <p className="mt-0.5 text-[11px] font-medium text-ink-faint">{metaLine(latest)}</p>
        {latest.insight && (
          <p className={`mt-1.5 line-clamp-2 hidden max-w-xl sm:block ${insightCls}`}>
            {latest.insight}
          </p>
        )}
      </div>

      {/* Mobile-only insight: full card width. Placed before the A/E/L cell so
          grid auto-flow keeps it on its own row; hidden on sm+ where the
          insight lives under the name instead. */}
      {latest.insight && (
        <p className={`col-span-3 line-clamp-3 sm:hidden ${insightCls}`}>{latest.insight}</p>
      )}

      <div className="col-span-3 flex sm:col-span-1">
        <SubLines latest={latest} />
      </div>

      <ChevronRight className="col-start-3 row-start-1 h-4 w-4 shrink-0 text-ink-faint sm:col-start-4" strokeWidth={2.2} />
    </Link>
  );
}

export default function StudentScores({ className = 'mt-5', delay = 180 }) {
  const { studentScores, ensure, refresh } = useDevData();
  useEffect(() => ensure('studentScores'), [ensure]);
  const data = studentScores.data;

  const [query, setQuery] = useState('');
  const students = data?.students ?? [];
  const filtered = useMemo(
    () =>
      students.filter((s) =>
        fuzzyMatch(query, studentHaystack(s.name, s.grade, gradeFromClass(s.grade)))
      ),
    [students, query]
  );

  return (
    <Card className={className} delay={delay}>
      <div className="mb-1 flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5">
        <h2 className="font-display text-lg font-semibold text-ink">Student scores</h2>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {data && (
            <span className="text-[12px] font-medium text-ink-faint">
              {data.students.length} of {data.rosterCount} students scored
            </span>
          )}
          <SearchInput
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name or year…"
          />
        </div>
      </div>
      {studentScores.error ? (
        <ErrorNote message={studentScores.error} onRetry={() => refresh('studentScores')} />
      ) : !data ? (
        <TabSkeleton rows={4} />
      ) : data.students.length === 0 ? (
        <EmptyNote>No 📊 Scores tabs yet — run the NAS scorer first.</EmptyNote>
      ) : filtered.length === 0 ? (
        <EmptyNote>No students match “{query}”.</EmptyNote>
      ) : (
        <div>
          {filtered.map((s) => (
            <ScoreRow key={s.sheetId} student={s} />
          ))}
        </div>
      )}
    </Card>
  );
}
