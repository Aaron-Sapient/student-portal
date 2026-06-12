'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import { DateTime } from 'luxon';
import { ChevronLeft } from 'lucide-react';
import { Halo } from '@/app/(portal)/neu';
import { curveScore, gradeFromClass } from '@/lib/scores';
import { useDevData } from '../../DevDataContext';
import {
  Badge,
  Card,
  EmptyNote,
  ErrorNote,
  GhostButton,
  INPUT_CLS,
  NUM_INPUT_CLS,
  PageHeader,
  PillButton,
  TabSkeleton,
} from '../../devUi';
import { MINI_SUBS, SubLines, metaLine } from '../scoreUi';

// Per-student scoring page (slug = the student's sheet id, the primary key
// everywhere else). Shows the score trajectory over time — scoring sessions
// as lines/points, check-in dates as axis markers — plus every session in
// full, each editable in place.

const ZONE = 'America/Los_Angeles';
const DAY = 86400000;

const CHART_METRICS = [
  { key: 'overall', label: 'Overall', cls: 'text-terracotta', width: 2.5 },
  { key: 'academic', label: 'Academic', cls: 'text-moss', width: 1.5 },
  { key: 'ec', label: 'Extracurr.', cls: 'text-ochre', width: 1.5 },
  { key: 'leadership', label: 'Leadership', cls: 'text-terracotta-soft', width: 1.5 },
];

// Curved (display) values + raw, shaped like lib/scores' `latest` so SubLines
// and metaLine read it directly.
const toLatestShape = (s) => ({ ...s.shown, raw: s.raw, date: s.date, model: s.model });

// ── Chart ──────────────────────────────────────────────────────────────────
// Plain SVG, fixed viewBox; the container scrolls horizontally on phones so
// the labels stay legible instead of scaling down.
function ScoreChart({ sessions, checkins }) {
  const W = 760;
  const H = 286;
  const M = { l: 40, r: 18, t: 14, b: 78 };
  const plotW = W - M.l - M.r;
  const plotH = H - M.t - M.b;

  const ms = (iso) => DateTime.fromISO(iso, { zone: ZONE }).toMillis();
  const todayMs = DateTime.now().setZone(ZONE).startOf('day').toMillis();
  // Domain: through today, back at least ~6 weeks so early check-ins give the
  // one-or-two scoring points some context.
  const end = Math.max(ms(sessions[sessions.length - 1].date), todayMs) + 2 * DAY;
  const start = Math.min(ms(sessions[0].date), end - 44 * DAY);
  const x = (iso) => M.l + ((ms(iso) - start) / (end - start)) * plotW;
  const y = (v) => M.t + (1 - v / 100) * plotH;
  const axisY = y(0);

  const visCheckins = checkins.filter((c) => {
    const m = ms(c.date);
    return m >= start && m <= end;
  });

  // Session date labels, deduped by date (manual rows share dates with model
  // rows) and staggered onto a second row when neighbors crowd.
  const seen = new Set();
  const sessionLabels = [];
  for (const s of sessions) {
    if (seen.has(s.date)) continue;
    seen.add(s.date);
    sessionLabels.push({ x: x(s.date), text: DateTime.fromISO(s.date).toFormat('LLL d') });
  }
  let lastEnd = [-Infinity, -Infinity];
  for (const l of sessionLabels) {
    l.row = l.x - 24 < lastEnd[0] ? 1 : 0;
    if (l.row === 1 && l.x - 24 < lastEnd[1]) l.row = 0; // both crowded — give up staggering
    lastEnd[l.row] = l.x + 24;
  }

  // Check-in labels: thin to at most 8 so the strip stays readable.
  const ciStep = Math.max(1, Math.ceil(visCheckins.length / 8));
  const gridLines = [
    { v: 100, dash: '', label: '100' },
    { v: 70, dash: '4 4', label: '70 avg' },
    { v: 40, dash: '', label: '40' },
  ];

  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[640px]">
        {gridLines.map((g) => (
          <g key={g.v} className={g.dash ? 'text-ink-soft' : 'text-ink-faint'}>
            <line
              x1={M.l}
              x2={W - M.r}
              y1={y(g.v)}
              y2={y(g.v)}
              stroke="currentColor"
              strokeOpacity={g.dash ? 0.55 : 0.25}
              strokeDasharray={g.dash}
            />
            <text
              x={M.l - 6}
              y={y(g.v) + 3}
              textAnchor="end"
              fontSize={10}
              fill="currentColor"
              className="font-semibold"
            >
              {g.label}
            </text>
          </g>
        ))}

        {/* axis */}
        <line
          x1={M.l}
          x2={W - M.r}
          y1={axisY}
          y2={axisY}
          stroke="currentColor"
          className="text-ink-faint"
          strokeOpacity={0.5}
        />

        {/* score lines (curved display values) */}
        {CHART_METRICS.map((m) => {
          const pts = sessions.filter((s) => s.shown[m.key] != null);
          if (pts.length === 0) return null;
          return (
            <g key={m.key} className={m.cls}>
              {pts.length > 1 && (
                <polyline
                  points={pts.map((s) => `${x(s.date)},${y(s.shown[m.key])}`).join(' ')}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={m.width}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              )}
              {pts.map((s, i) => (
                <circle
                  key={`${s.row}-${i}`}
                  cx={x(s.date)}
                  cy={y(s.shown[m.key])}
                  r={m.key === 'overall' ? 4 : 3}
                  fill="currentColor"
                >
                  <title>{`${m.label} ${s.shown[m.key]} (raw ${s.raw[m.key]}) · ${s.date} · ${s.model || '—'}`}</title>
                </circle>
              ))}
            </g>
          );
        })}

        {/* scoring-session date labels */}
        {sessionLabels.map((l, i) => (
          <g key={i} className="text-ink-soft">
            <line
              x1={l.x}
              x2={l.x}
              y1={axisY}
              y2={axisY + 5}
              stroke="currentColor"
              strokeOpacity={0.7}
            />
            <text
              x={l.x}
              y={axisY + 18 + l.row * 13}
              textAnchor="middle"
              fontSize={10.5}
              fill="currentColor"
              className="font-semibold"
            >
              {l.text}
            </text>
          </g>
        ))}

        {/* check-in markers along the axis */}
        {visCheckins.map((c, i) => {
          const cx = x(c.date);
          return (
            <g key={i} className="text-ink-faint">
              <path
                d={`M ${cx} ${axisY - 5} L ${cx - 4} ${axisY + 2} L ${cx + 4} ${axisY + 2} Z`}
                fill="currentColor"
                fillOpacity={0.85}
              >
                <title>{`Check-in (${c.who}) · ${c.date}`}</title>
              </path>
              {i % ciStep === 0 && (
                <text
                  x={cx}
                  y={axisY + 46}
                  textAnchor="middle"
                  fontSize={9.5}
                  fill="currentColor"
                >
                  {DateTime.fromISO(c.date).toFormat('L/d')}
                </text>
              )}
            </g>
          );
        })}
        <text
          x={M.l}
          y={H - 6}
          fontSize={9.5}
          fill="currentColor"
          className="text-ink-faint"
        >
          ▲ check-ins · labeled dates above the axis are Claude scoring runs
        </text>
      </svg>
    </div>
  );
}

function ChartLegend() {
  return (
    <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1">
      {CHART_METRICS.map((m) => (
        <span key={m.key} className="flex items-center gap-1.5 text-[11px] font-medium text-ink-soft">
          <span className={`h-1.5 w-4 rounded-full bg-current ${m.cls}`} />
          {m.label}
        </span>
      ))}
    </div>
  );
}

// ── Session log ────────────────────────────────────────────────────────────
// One card per 📊 Scores row, newest first; Edit rewrites that row in place
// (raw scale — Overall recomputes server-side from the blend weights).
function SessionCard({ session, sheetId, grade, onSaved }) {
  const [editing, setEditing] = useState(false);
  const [vals, setVals] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const num = (v) => (v === '' ? null : Number(v));
  const valid =
    vals &&
    MINI_SUBS.every((s) => {
      const n = num(vals[s.key]);
      return Number.isInteger(n) && n >= 0 && n <= 100;
    });
  const dirty =
    vals &&
    (MINI_SUBS.some((s) => num(vals[s.key]) !== (session.raw[s.key] ?? null)) ||
      vals.insight.trim() !== (session.insight ?? '') ||
      vals.coachNote.trim() !== (session.coachNote ?? ''));

  const startEdit = () => {
    setVals({
      academic: session.raw.academic ?? '',
      ec: session.raw.ec ?? '',
      leadership: session.raw.leadership ?? '',
      insight: session.insight ?? '',
      coachNote: session.coachNote ?? '',
    });
    setError(null);
    setEditing(true);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/developer/studentScores/${sheetId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          row: session.row,
          date: session.date,
          academic: num(vals.academic),
          ec: num(vals.ec),
          leadership: num(vals.leadership),
          insight: vals.insight.trim(),
          coachNote: vals.coachNote.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');
      setEditing(false);
      onSaved();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="border-t border-sand py-4 first:border-t-0">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-display text-[15px] font-semibold text-ink">{session.date}</h3>
        {session.model && <Badge tone="muted">{session.model}</Badge>}
        {session.rubricVer && (
          <span className="text-[11px] font-medium text-ink-faint">{session.rubricVer}</span>
        )}
        <div className="ml-auto">
          {!editing && !session.v1 && (
            <GhostButton onClick={startEdit} className="px-3 py-1.5 text-[12px]">
              Edit
            </GhostButton>
          )}
        </div>
      </div>

      {/* raw → shown, all four values */}
      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1.5">
        {[...MINI_SUBS, { key: 'overall', letter: 'O', label: 'Overall' }].map((m) => (
          <span key={m.key} className="text-[12px] text-ink-soft" title={m.label}>
            <span className="font-bold uppercase text-ink-faint">{m.letter} </span>
            raw {session.raw[m.key] ?? '—'}
            <span className="text-ink-faint"> → </span>
            <span className="font-semibold text-ink">{session.shown[m.key] ?? '—'}</span>
          </span>
        ))}
      </div>

      {editing && (
        <div className="neu-inset mt-3 rounded-2xl p-4">
          <div className="space-y-2">
            {MINI_SUBS.map((sub) => {
              const n = num(vals[sub.key]);
              const ok = Number.isInteger(n) && n >= 0 && n <= 100;
              return (
                <div key={sub.key} className="flex items-center gap-3">
                  <span className="w-28 shrink-0 text-[13px] text-ink-soft">{sub.label}</span>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={vals[sub.key]}
                    onChange={(e) =>
                      setVals((s) => ({
                        ...s,
                        [sub.key]: e.target.value === '' ? '' : Number(e.target.value),
                      }))
                    }
                    className={NUM_INPUT_CLS}
                  />
                  <span className="text-[12px] font-medium text-ink-faint">
                    → shows{' '}
                    <span className="font-semibold text-ink">{ok ? curveScore(n, grade) : '—'}</span>
                  </span>
                </div>
              );
            })}
          </div>
          {/* Insight + Coach note — the latest session's note is what the
              student's Claude Coach card serves; blank = no note shown. */}
          <div className="mt-3 space-y-2.5">
            {[
              { key: 'insight', label: 'Insight', rows: 3 },
              { key: 'coachNote', label: 'Coach note (student-facing)', rows: 3 },
            ].map((f) => (
              <div key={f.key}>
                <label className="mb-1 block text-[12px] font-semibold text-ink-soft">
                  {f.label}
                </label>
                <textarea
                  rows={f.rows}
                  value={vals[f.key]}
                  onChange={(e) => setVals((s) => ({ ...s, [f.key]: e.target.value }))}
                  className={`${INPUT_CLS} w-full resize-y leading-relaxed`}
                />
              </div>
            ))}
          </div>
          <p className="mt-2.5 text-[11px] leading-relaxed text-ink-faint">
            Rewrites this session in place (raw scale). Overall recomputes from the blend
            weights and the row is stamped “edited”. The newest session’s coach note is what
            students see — clearing it hides the note.
          </p>
          {error && <p className="mt-2 text-[12px] font-medium text-terracotta-deep">{error}</p>}
          <div className="mt-3 flex items-center gap-2.5">
            <PillButton onClick={save} disabled={saving || !valid || !dirty}>
              {saving ? 'Saving…' : 'Save session'}
            </PillButton>
            <GhostButton onClick={() => setEditing(false)} disabled={saving}>
              Cancel
            </GhostButton>
          </div>
        </div>
      )}

      {(session.insight || session.coachNote) && (
        <div className="mt-3 space-y-2">
          {session.insight && (
            <p className="font-display text-[13.5px] leading-relaxed text-ink-soft">
              {session.insight}
            </p>
          )}
          {session.coachNote && (
            <p className="font-display text-[13.5px] leading-relaxed text-ink-soft">
              <span className="font-semibold text-ink">Coach note: </span>
              {session.coachNote}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────
export default function StudentScorePage() {
  const { sheetId } = useParams();
  const { refresh } = useDevData();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/developer/studentScores/${sheetId}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Load failed');
      setData(json);
    } catch (e) {
      setError(e.message);
    }
  }, [sheetId]);
  useEffect(() => {
    load();
  }, [load]);

  const onSaved = () => {
    load();
    refresh('studentScores'); // keep the roster list in sync for the way back
  };

  // Back to wherever this page was opened from — the Scoring tab when under
  // /developer/scoring/<id>, the simplified list when under /dev/<id>.
  const pathname = usePathname() || '';
  const backHref = pathname.slice(0, pathname.lastIndexOf('/')) || '/developer/scoring';

  const back = (
    <Link
      href={backHref}
      className="mb-4 inline-flex items-center gap-1 text-[13px] font-semibold text-ink-soft transition-opacity active:opacity-70"
    >
      <ChevronLeft className="h-4 w-4" strokeWidth={2.2} />
      Scoring
    </Link>
  );

  if (error) {
    return (
      <div>
        {back}
        <PageHeader eyebrow="Holistic scores" title="Student" />
        <ErrorNote message={error} onRetry={load} />
      </div>
    );
  }
  if (!data) {
    return (
      <div>
        {back}
        <TabSkeleton rows={4} />
      </div>
    );
  }

  const { sessions, checkins } = data;
  const latest = sessions.length ? toLatestShape(sessions[sessions.length - 1]) : null;
  const isStale =
    latest &&
    DateTime.fromISO(latest.date, { zone: ZONE }) <
      DateTime.now().setZone(ZONE).minus({ days: 10 });

  return (
    <div>
      {back}
      <PageHeader eyebrow="Holistic scores" title={data.name}>
        <p className="mt-1 text-[13px] font-medium text-ink-soft">
          {data.grade && <span>{data.grade} · </span>}
          {latest ? metaLine(latest) : 'no scoring sessions yet'}
          {isStale && (
            <span className="ml-2 align-middle">
              <Badge tone="ochre">Stale</Badge>
            </span>
          )}
        </p>
      </PageHeader>

      {!latest ? (
        <Card>
          <EmptyNote>No 📊 Scores tab yet — run the NAS scorer for this student first.</EmptyNote>
        </Card>
      ) : (
        <>
          <Card>
            <div className="flex max-w-md items-center gap-5">
              <Halo
                rings={[{ value: (latest.overall ?? 0) / 100, className: 'text-terracotta' }]}
                size={96}
                stroke={15}
              >
                <p className="font-display text-2xl font-semibold leading-none text-ink">
                  {latest.overall ?? '—'}
                </p>
              </Halo>
              <SubLines latest={latest} />
            </div>
          </Card>

          <Card className="mt-5" delay={140}>
            <h2 className="mb-3 font-display text-lg font-semibold text-ink">Score history</h2>
            <ChartLegend />
            <ScoreChart sessions={sessions} checkins={checkins} />
          </Card>

          <Card className="mt-5" delay={190}>
            <h2 className="mb-1 font-display text-lg font-semibold text-ink">
              Scoring sessions
              <span className="ml-2 text-[12px] font-medium text-ink-faint">
                {sessions.length} total · {checkins.length} check-ins on file
              </span>
            </h2>
            {[...sessions].reverse().map((s) => (
              <SessionCard
                key={`${s.row}-${s.date}`}
                session={s}
                sheetId={sheetId}
                grade={gradeFromClass(data.grade)}
                onSaved={onSaved}
              />
            ))}
          </Card>
        </>
      )}
    </div>
  );
}
