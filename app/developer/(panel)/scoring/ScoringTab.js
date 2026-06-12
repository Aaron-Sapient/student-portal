'use client';

import { useEffect, useState } from 'react';
import { useDevData } from '../DevDataContext';
import {
  Card,
  ErrorNote,
  GhostButton,
  NUM_INPUT_CLS,
  PageHeader,
  PillButton,
  TabSkeleton,
} from '../devUi';
import StudentScores from './StudentScores';

// Tunable point weights for the weekly holistic scoring run (rubric v2). Saved
// to the Master Sheet's hidden ⚙️ Score Params tab; the NAS scorer reads them at
// run time, so edits apply from the next scoring run with no redeploy.
export default function ScoringTab({ includeStudents = true }) {
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
          Point weights fed to the weekly Claude scoring run. Each column must total its
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

      {includeStudents && <StudentScores />}
    </div>
  );
}
