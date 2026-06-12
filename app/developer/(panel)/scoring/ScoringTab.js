'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronRight } from 'lucide-react';
import { Halo } from '@/app/(portal)/neu';
import { gradeFromClass } from '@/lib/scores';
import { useDevData } from '../DevDataContext';
import { fuzzyMatch, studentHaystack } from '../fuzzy';
import {
  Badge,
  Card,
  EmptyNote,
  ErrorNote,
  GhostButton,
  NUM_INPUT_CLS,
  PageHeader,
  PillButton,
  SearchInput,
  TabSkeleton,
} from '../devUi';
import { metaLine, SubLines } from './scoreUi';

// Desktop (sm+): the original three-column row — wheel | name+insight | A/E/L.
// Mobile: the wheel+name header keeps row one, then the insight and the A/E/L
// lines each take the full card width below (no orphaned bottom-right gap).
// The whole row links to the student's page (slug = sheet id), relative to the
// current path so the list works from both /developer/scoring and /dev.
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

function StudentScores() {
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
    <Card className="mt-5" delay={180}>
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

// Tunable point weights for the weekly holistic scoring run (rubric v2). Saved
// to the Master Sheet's hidden ⚙️ Score Params tab; the NAS scorer reads them at
// run time, so edits apply from the next scoring run with no redeploy.
export default function ScoringTab() {
  const { scoreParams, ensure, refresh } = useDevData();
  useEffect(() => ensure('scoreParams'), [ensure]);

  const paramData = scoreParams.data;
  const [values, setValues] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (paramData) setValues({ ...paramData.params });
  }, [paramData]);

  if (scoreParams.error) {
    return (
      <div>
        <PageHeader eyebrow="Rubric v2" title="Scoring" />
        <ErrorNote message={scoreParams.error} onRetry={() => refresh('scoreParams')} />
      </div>
    );
  }
  if (!paramData || !values) {
    return (
      <div>
        <PageHeader eyebrow="Rubric v2" title="Scoring" />
        <TabSkeleton rows={3} />
      </div>
    );
  }

  const { groups, defaults } = paramData;

  const groupSum = (g) => g.params.reduce((a, p) => a + (Number(values[p.key]) || 0), 0);
  const allValid = groups.every((g) => groupSum(g) === g.total);
  const dirty = Object.keys(values).some((k) => values[k] !== paramData.params[k]);
  const isDefault = Object.keys(values).every((k) => values[k] === defaults[k]);

  const save = async () => {
    setSaving(true);
    try {
      const clean = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, Number(v)]));
      const res = await fetch('/api/developer/score-params', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ params: clean }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert('Save failed: ' + (data.error || 'unknown'));
        return;
      }
      await refresh('scoreParams');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <PageHeader eyebrow="Rubric v2" title="Scoring">
        <p className="mt-2 max-w-xl text-[13px] leading-relaxed text-ink-soft">
          Point weights fed to the weekly Opus scoring run. Each column must total its
          target; changes apply from the next scoring run.
        </p>
      </PageHeader>

      <Card>
        <div className="flex flex-wrap gap-8">
          {groups.map((g) => {
            const sum = groupSum(g);
            const ok = sum === g.total;
            return (
              <div key={g.key} className="min-w-[220px] flex-1">
                <h3 className="mb-2 font-display text-[15px] font-semibold text-ink">
                  {g.label}
                </h3>
                {g.params.map((p) => (
                  <label
                    key={p.key}
                    className="flex items-center justify-between gap-2 py-1 text-[13px]"
                  >
                    <span
                      className={
                        values[p.key] === defaults[p.key] ? 'text-ink-soft' : 'text-terracotta-deep'
                      }
                    >
                      {p.label}
                      {values[p.key] !== defaults[p.key] && (
                        <span className="text-[11px] text-ink-faint">{` (default ${defaults[p.key]})`}</span>
                      )}
                    </span>
                    <input
                      type="number"
                      min={0}
                      max={100}
                      value={values[p.key]}
                      onChange={(e) =>
                        setValues((s) => ({
                          ...s,
                          [p.key]: e.target.value === '' ? '' : Number(e.target.value),
                        }))
                      }
                      className={`${NUM_INPUT_CLS}`}
                    />
                  </label>
                ))}
                <div
                  className={`mt-2 border-t border-sand pt-2 text-right text-[12px] font-semibold ${
                    ok ? 'text-moss' : 'text-terracotta-deep'
                  }`}
                >
                  {sum} / {g.total}
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-5 flex items-center gap-2.5">
          <PillButton onClick={save} disabled={saving || !allValid || !dirty}>
            {saving ? 'Saving…' : 'Save parameters'}
          </PillButton>
          <GhostButton onClick={() => setValues({ ...defaults })} disabled={saving || isDefault}>
            Reset to defaults
          </GhostButton>
          {!allValid && (
            <span className="text-[12px] font-medium text-terracotta-deep">
              Fix the column totals before saving.
            </span>
          )}
        </div>
      </Card>

      <StudentScores />
    </div>
  );
}
