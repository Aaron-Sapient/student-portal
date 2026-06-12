'use client';

import { useEffect, useId, useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight, ChevronRight } from 'lucide-react';

// Shared neumorphic primitives for the portal tabs. The surface classes
// (.neu-raised / .neu-chip / .neu-inset) live in globals.css; these are the
// composed pieces every tab reuses so the language stays consistent.

export function Eyebrow({ children }) {
  return (
    <p className="text-xs font-semibold uppercase tracking-[0.13em] text-ink-soft">{children}</p>
  );
}

// Pressed-in track with a warm fill — the one accent element per card.
// fillClassName retints the fill (gauge lines carry their score's identity hue).
export function Bar({ value, fillClassName = 'bg-gradient-to-r from-terracotta-soft to-terracotta' }) {
  const v = Math.max(0, Math.min(1, value || 0));
  return (
    <div className="neu-inset h-3.5 flex-1 rounded-full p-[3px]">
      <div
        className={`h-full rounded-full ${fillClassName}`}
        style={{ width: `${v * 100}%`, minWidth: v > 0 ? '0.6rem' : 0 }}
      />
    </div>
  );
}

export function Stat({ value, label }) {
  return (
    <div className="neu-raised rounded-3xl px-3 py-4 text-center">
      <p className="font-display text-2xl font-semibold text-ink">{value ?? '—'}</p>
      <p className="mt-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
        {label}
      </p>
    </div>
  );
}

// Round icon button that opens an external doc/link in a new tab.
export function DocLink({ href, label }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      title={label}
      className="neu-chip flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-terracotta-deep transition-transform active:scale-90"
    >
      <ArrowUpRight className="h-4.5 w-4.5" strokeWidth={2.2} />
    </a>
  );
}

// Soft-extruded square tile that frames a lucide icon (chooser rows, empty states).
// muted: grays the glyph for locked/disabled rows.
export function IconTile({ icon: Icon, size = 'md', muted = false }) {
  const dims = size === 'lg' ? 'h-16 w-16 rounded-3xl' : 'h-14 w-14 rounded-2xl';
  const glyph = size === 'lg' ? 'h-7 w-7' : 'h-6 w-6';
  return (
    <span
      className={`neu-chip flex shrink-0 items-center justify-center ${
        muted ? 'text-ink-faint' : 'text-terracotta'
      } ${dims}`}
    >
      <Icon className={glyph} strokeWidth={1.8} />
    </span>
  );
}

// Concentric activity rings inside a pressed-in well — the Home centerpiece.
// rings: outer→inner [{ value: 0..1, className: 'text-terracotta' }, …].
// Children render in the center (score number, delta chip, captions).
export function Halo({ rings, size = 208, stroke = 11, children }) {
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setDrawn(true));
    return () => cancelAnimationFrame(id);
  }, []);
  const STROKE = stroke;
  const GAP = 4;
  const R0 = 76; // outer ring radius in a 168 viewBox
  return (
    <div
      className="neu-inset relative flex items-center justify-center rounded-full"
      style={{ width: size, height: size }}
    >
      <svg viewBox="0 0 168 168" className="-rotate-90" style={{ width: size - 24, height: size - 24 }}>
        {rings.map(({ value, className }, i) => {
          const r = R0 - i * (STROKE + GAP);
          const c = 2 * Math.PI * r;
          const v = Math.max(0, Math.min(1, value || 0));
          return (
            <g key={i}>
              <circle
                cx="84"
                cy="84"
                r={r}
                fill="none"
                stroke="currentColor"
                strokeWidth={STROKE}
                className="text-ink/[0.07]"
              />
              <circle
                cx="84"
                cy="84"
                r={r}
                fill="none"
                stroke="currentColor"
                strokeWidth={STROKE}
                strokeLinecap="round"
                strokeDasharray={c}
                strokeDashoffset={drawn ? c * (1 - v) : c}
                className={className}
                style={{
                  transition: `stroke-dashoffset 1.1s cubic-bezier(0.3, 0.7, 0.2, 1) ${200 + i * 160}ms`,
                }}
              />
            </g>
          );
        })}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">{children}</div>
    </div>
  );
}

// Score-movement slope chart: X = time (check-ins stretched across the full
// width, max 4 plus the zero-anchor start), Y = signed delta around a dashed
// zero baseline. One diagonal line per score — Overall solid and thicker,
// sub-scores thin dotted threads in their identity hues. Dotted ± guides label
// the extremes; dashed verticals carry the check-in dates: proof that we track
// these week over week.
// points: oldest → newest [{ label, deltas: { overall, academic, ec, leadership } }]
// (first point is conventionally the zero anchor at the prior check-in).
// dash: near-zero dashes + round caps render as dots.
const DELTA_SERIES = [
  { key: 'overall', cls: 'text-terracotta', width: 3 },
  // Sub-score dots are 2.5px beads: at thinner widths the hue can't survive
  // antialiasing and the threads read as gray instead of their bar colors.
  { key: 'academic', cls: 'text-moss', width: 2.5, dash: '0.1 4.5' },
  { key: 'ec', cls: 'text-ochre', width: 2.5, dash: '0.1 4.5' },
  { key: 'leadership', cls: 'text-terracotta-soft', width: 2.5, dash: '0.1 4.5' },
];

export function DeltaLines({ points, height = 116 }) {
  if (!points || points.length < 2) return null;
  const maxAbs = Math.max(
    5,
    ...points.flatMap((p) => Object.values(p.deltas).map((v) => Math.abs(v ?? 0)))
  );
  // Time stretches across the chart: points inset 4%..96% of the width.
  const x = (i) => 4 + (i / (points.length - 1)) * 92;
  const y = (v) => 50 - ((v ?? 0) / maxAbs) * 44;
  return (
    <div aria-hidden>
      <div className="relative" style={{ height }}>
        {/* guides: zero baseline (dashed) + ± extents (dotted, labeled) */}
        <div className="pointer-events-none absolute inset-x-0 top-1/2 border-t border-dashed border-ink-faint/40" />
        <div className="pointer-events-none absolute inset-x-0 top-[6%] border-t border-dotted border-ink-faint/25" />
        <div className="pointer-events-none absolute inset-x-0 bottom-[6%] border-t border-dotted border-ink-faint/25" />
        <span className="pointer-events-none absolute right-1 top-[6%] -translate-y-full text-[8px] font-semibold text-ink-faint/70">
          +{maxAbs}
        </span>
        <span className="pointer-events-none absolute bottom-[6%] right-1 translate-y-full text-[8px] font-semibold text-ink-faint/70">
          −{maxAbs}
        </span>
        {/* dashed verticals at each check-in */}
        {points.map((p, i) => (
          <div
            key={`v-${i}`}
            className="pointer-events-none absolute inset-y-0 -translate-x-1/2 border-l border-dashed border-ink-faint/30"
            style={{ left: `${x(i)}%` }}
          />
        ))}
        {/* the diagonals */}
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="absolute inset-0 h-full w-full"
        >
          {DELTA_SERIES.map((s) => (
            <polyline
              key={s.key}
              points={points.map((p, i) => `${x(i)},${y(p.deltas[s.key])}`).join(' ')}
              fill="none"
              stroke="currentColor"
              strokeWidth={s.width}
              strokeDasharray={s.dash}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              className={s.cls}
            />
          ))}
        </svg>
      </div>
      {/* date labels under their verticals */}
      <div className="relative mt-1.5 h-3.5">
        {points.map((p, i) => (
          <span
            key={`l-${i}`}
            className="absolute -translate-x-1/2 whitespace-nowrap text-[9px] font-semibold uppercase tracking-[0.1em] text-ink-faint"
            style={{ left: `${x(i)}%` }}
          >
            {p.label}
          </span>
        ))}
      </div>
    </div>
  );
}

// Weekly-frequency ridge: one molded clay peak per week (oldest → newest),
// rising from the floor of a pressed-in well — the habit tracker's Movement
// ridge translated to the portal palette. Quiet weeks leave a flat pebble.
export function WeekBars({ weeks, height = 64 }) {
  const max = Math.max(1, ...weeks.map((w) => w.count));
  return (
    <div className="flex items-end gap-1.5 overflow-hidden" style={{ height }}>
      {weeks.map((w, i) => {
        const h = w.count === 0 ? 4 : Math.max(16, Math.round((w.count / max) * (height - 10)));
        return (
          <div key={w.week} className="flex flex-1 items-end" title={`${w.week} · ${w.count}`}>
            <div
              className={`w-full ${w.count > 0 ? 'clay-peak' : 'rounded-full bg-ink-faint/25'}`}
              style={{ height: h, animationDelay: `${260 + i * 70}ms` }}
            />
          </div>
        );
      })}
    </div>
  );
}

// Slim conditional pointer row — Home's only text containers. Renders as a
// Link (href) or button (onClick). `alert` adds the terracotta needs-you dot.
export function PointerRow({ icon: Icon, label, sub, href, onClick, alert = false, delay = 0 }) {
  const inner = (
    <>
      <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-terracotta-deep">
        <Icon className="h-4.5 w-4.5" strokeWidth={2.1} />
        {alert && (
          <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-terracotta ring-2 ring-cream" />
        )}
      </span>
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate text-sm font-semibold text-ink">{label}</span>
        {sub && <span className="block truncate text-xs text-ink-soft">{sub}</span>}
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-ink-faint" strokeWidth={2.2} />
    </>
  );
  const cls =
    'portal-rise neu-chip flex w-full items-center gap-3 rounded-2xl px-3.5 py-3 transition-transform active:scale-[0.98]';
  const style = { animationDelay: `${delay}ms` };
  return href ? (
    <Link href={href} className={cls} style={style}>
      {inner}
    </Link>
  ) : (
    <button type="button" onClick={onClick} className={cls} style={style}>
      {inner}
    </button>
  );
}

// Subtab dial: a pressed groove holding one raised knob per section. Each knob
// carries its icon plus a whisper of a label — icon-only proved a touch too
// understated to navigate. The groove hugs its knobs (w-fit) so two sections
// sit together instead of being flung to opposite walls.
export function SectionDial({ sections, value, onChange }) {
  return (
    <div
      role="tablist"
      aria-label="Sections"
      className="neu-inset mx-auto flex w-fit max-w-full items-center justify-center gap-1.5 rounded-full p-2"
    >
      {sections.map(({ key, label, icon: Icon }) => {
        const active = key === value;
        return (
          <button
            key={key}
            role="tab"
            aria-selected={active}
            aria-label={label}
            title={label}
            onClick={() => onChange(key)}
            className={`flex min-w-[4.25rem] flex-col items-center gap-0.5 rounded-full px-4 py-2 transition-all duration-200 ${
              active ? 'neu-raised text-terracotta-deep' : 'text-ink-faint active:scale-90'
            }`}
          >
            <Icon className="h-5 w-5" strokeWidth={2.1} />
            <span className="whitespace-nowrap text-[9px] font-bold uppercase tracking-[0.08em]">
              {label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* ── Clay hero emblems ──────────────────────────────────────────────────────
   The habit tracker's header mark, ripped 1:1 (geometry + palette live in
   globals.css as .clay-mark): a molded clay chip + three drifting blobs, with
   one gradient glyph per tab. Each glyph is drawn twice — gradient body plus
   a thin top-left light ridge — so it reads as molded, not printed. */

// plain: children are CSS-built (the bloom), not SVG glyph paths.
function ClayMark({ scale = 1, plain = false, children }) {
  return (
    <span
      aria-hidden
      className="inline-block shrink-0"
      style={{ width: 58 * scale, height: 58 * scale }}
    >
      <span
        className="clay-mark"
        style={scale !== 1 ? { transform: `scale(${scale})`, transformOrigin: 'top left' } : undefined}
      >
        <span className="clay-mark-blobs">
          <span className="clay-blob clay-blob-1" />
          <span className="clay-blob clay-blob-2" />
          <span className="clay-blob clay-blob-3" />
        </span>
        <span className="clay-mark-chip">
          {plain ? children : <svg viewBox="0 0 32 32">{children}</svg>}
        </span>
      </span>
    </span>
  );
}

const RIDGE = {
  fill: 'none',
  stroke: 'rgba(255,255,255,0.38)',
  strokeWidth: 1.6,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  transform: 'translate(-1.1 -1.3)',
};

// useId's raw value («r5») isn't safe inside SVG url(#…) — keep the unique
// token, drop the delimiters.
function useGradId() {
  return 'ck' + useId().replace(/\W/g, '');
}

// user: span the gradient across the whole 32×32 glyph in user space instead
// of each shape's own bbox — REQUIRED whenever any painted path is a purely
// horizontal/vertical line (zero-area bbox ⇒ objectBoundingBox gradients
// don't render and the path silently disappears).
function ClayGrad({ id, from, to, user = false }) {
  const span = user
    ? { x1: 0, y1: 0, x2: 32, y2: 32, gradientUnits: 'userSpaceOnUse' }
    : { x1: 0, y1: 0, x2: 1, y2: 1 };
  return (
    <defs>
      <linearGradient id={id} {...span}>
        <stop offset="0" stopColor={from} />
        <stop offset="1" stopColor={to} />
      </linearGradient>
    </defs>
  );
}

// Check-ins: the original sage check, verbatim.
export function ClayCheck({ scale = 1 }) {
  const id = useGradId();
  const d = 'M7.5 17.5 L13.5 23.5 L24.5 9.5';
  return (
    <ClayMark scale={scale}>
      <ClayGrad id={id} from="var(--ck-sage-lite)" to="var(--ck-sage-deep)" />
      <path d={d} fill="none" stroke={`url(#${id})`} strokeWidth="6.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d={d} {...RIDGE} />
    </ClayMark>
  );
}

// Home: the check-in's "great week" bloom, verbatim — the WeekFeel
// blob frozen at the top of its slider (colors are the t = 1 outputs of
// WeekFeel's mixes), petal ring still orbiting — molded onto the same chip as
// the other glyphs. Authored at the blob's native 190px stage and shrunk to
// glyph size (~34px, the chip's 62% glyph footprint) so it shares the .feel-*
// shells exactly.
export function ClayBloom({ scale = 1 }) {
  return (
    <ClayMark scale={scale} plain>
      <span className="relative h-[34px] w-[34px]">
        <span
          className="absolute left-1/2 top-1/2 h-[190px] w-[190px]"
          style={{ transform: 'translate(-50%, -50%) scale(0.183)' }}
        >
          <span className="feel-breathe">
            <span className="feel-petal-ring">
              {[0, 72, 144, 216, 288].map((a) => (
                <span
                  key={a}
                  className="feel-petal"
                  style={{ transform: `rotate(${a}deg) translateY(-54px)` }}
                />
              ))}
            </span>
            <span
              className="feel-core"
              style={{
                background:
                  'radial-gradient(circle at 34% 28%, rgb(243,208,166), rgb(198,97,63) 62%, rgb(164,84,56))',
              }}
            />
          </span>
        </span>
      </span>
    </ClayMark>
  );
}

// Colleges: a butter landmark — the Schools sub-tab's building, molded very
// squishy: puffy pediment over one wide pillow of a pillar (a rounded rect
// rather than a capsule so its height, width, and corner squish tune
// independently).
export function ClayLandmark({ scale = 1 }) {
  const id = useGradId();
  const roof = 'M16 4.8 L26.6 11.3 H5.4 Z';
  const pillar = { x: 7.5, y: 14, width: 17, height: 13.8, rx: 4.8 };
  return (
    <ClayMark scale={scale}>
      <ClayGrad id={id} from="var(--ck-butter)" to="var(--ck-butter-deep)" user />
      <path
        d={roof}
        fill={`url(#${id})`}
        stroke={`url(#${id})`}
        strokeWidth="3"
        strokeLinejoin="round"
      />
      <path d={roof} {...RIDGE} />
      <rect {...pillar} fill={`url(#${id})`} />
      <rect {...pillar} {...RIDGE} />
    </ClayMark>
  );
}

// Meetings: a terracotta video camera.
export function ClayCam({ scale = 1 }) {
  const id = useGradId();
  const body = 'M7 9.5h9a3.5 3.5 0 0 1 3.5 3.5v6a3.5 3.5 0 0 1-3.5 3.5H7A3.5 3.5 0 0 1 3.5 19v-6A3.5 3.5 0 0 1 7 9.5z';
  const lens = 'M21.5 14.4l6-3.2a0.7 0.7 0 0 1 1 0.6v8.4a0.7 0.7 0 0 1-1 .6l-6-3.2z';
  return (
    <ClayMark scale={scale}>
      <ClayGrad id={id} from="var(--ck-terra-lite)" to="var(--ck-terra)" />
      <path d={body} fill={`url(#${id})`} />
      <path d={lens} fill={`url(#${id})`} />
      <path d={body} {...RIDGE} />
      <path d={lens} {...RIDGE} />
    </ClayMark>
  );
}

// Files: a plum folder.
export function ClayFolder({ scale = 1 }) {
  const id = useGradId();
  const d =
    'M4.5 10.5a3 3 0 0 1 3-3h6l3 3.2h8a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3h-17a3 3 0 0 1-3-3z';
  return (
    <ClayMark scale={scale}>
      <ClayGrad id={id} from="var(--ck-plum-lite)" to="var(--ck-plum)" />
      <path d={d} fill={`url(#${id})`} />
      <path d={d} {...RIDGE} />
    </ClayMark>
  );
}
