'use client';

import { useRef, useState } from 'react';

// Claymorphic task-status selector — replaces the three text pills. A clay
// knob slides along a pressed groove with three engraved detents; the fill
// behind it IS the state, so there's no selected-vs-not ambiguity: empty
// trough = not started, half-filled amber = in progress, full moss = done.
// Drag the knob, tap anywhere in the groove, or tap a label.

const DETENTS = [
  { value: 'Not Started', label: 'Not started', pos: 0 },
  { value: 'In Progress', label: 'In progress', pos: 0.5 },
  { value: 'Completed', label: 'Done', pos: 1 },
];

const HUES = {
  'Not Started': null, // raw clay, no fill
  'In Progress': 'var(--color-ochre)',
  Completed: 'var(--color-moss)',
};

const nearestDetent = (pos) =>
  DETENTS.reduce((a, b) => (Math.abs(b.pos - pos) < Math.abs(a.pos - pos) ? b : a));

// Knob is 2rem wide inside a 0.25rem groove inset; both calcs share this rail.
const railLeft = (pos) => `calc(0.25rem + ${pos} * (100% - 2.5rem))`;

export default function TaskTrough({ value, onChange }) {
  const railRef = useRef(null);
  const [drag, setDrag] = useState(null); // live 0..1 while the pointer is down

  const detent = DETENTS.find((d) => d.value === value) || null;
  const pos = drag !== null ? drag : detent ? detent.pos : 0;
  const hue = HUES[(drag !== null ? nearestDetent(drag) : detent)?.value] ?? null;
  const settled = drag === null;

  function ratioFrom(e) {
    const rect = railRef.current.getBoundingClientRect();
    const inset = 20; // groove inset + half the knob, in px
    return Math.max(0, Math.min(1, (e.clientX - rect.left - inset) / (rect.width - inset * 2)));
  }
  function down(e) {
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setDrag(ratioFrom(e));
  }
  function move(e) {
    if (drag !== null) setDrag(ratioFrom(e));
  }
  function up() {
    if (drag === null) return;
    onChange(nearestDetent(drag).value);
    setDrag(null);
  }

  return (
    <div>
      <div
        ref={railRef}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        role="slider"
        aria-label="Task status"
        aria-valuemin={0}
        aria-valuemax={2}
        aria-valuenow={detent ? DETENTS.indexOf(detent) : 0}
        aria-valuetext={detent ? detent.label : 'Not set'}
        className="neu-inset relative h-10 cursor-pointer touch-none select-none rounded-full"
      >
        {/* engraved detent dimples the knob nests into */}
        {DETENTS.map((d) => (
          <span
            key={d.value}
            aria-hidden
            className="absolute top-1/2 h-[18px] w-[18px] -translate-y-1/2 rounded-full"
            style={{
              left: `calc(${railLeft(d.pos)} + 7px)`,
              boxShadow:
                'inset 1.5px 2.5px 4px var(--neu-lo), inset -1.5px -1.5px 3px var(--neu-hi)',
            }}
          />
        ))}
        {/* progress fill: kneaded clay from the left wall to the knob */}
        {hue && (
          <div
            className={`absolute inset-y-1 left-1 rounded-full ${
              settled ? 'transition-all duration-300' : ''
            }`}
            style={{
              width: `calc(${pos} * (100% - 2.5rem) + 2rem)`,
              background: `linear-gradient(165deg, color-mix(in srgb, ${hue} 55%, #fffcf3), ${hue})`,
              boxShadow:
                'inset 1.5px 2px 3px rgba(255,255,255,0.4), inset -2px -3px 5px rgba(0,0,0,0.18)',
            }}
          />
        )}
        {/* the clay knob — takes on the detent's hue once it settles there */}
        <div
          aria-hidden
          className={`absolute top-1 h-8 w-8 rounded-full ${
            settled ? 'transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)]' : ''
          }`}
          style={{
            left: railLeft(pos),
            background: hue
              ? `radial-gradient(circle at 32% 26%, color-mix(in srgb, ${hue} 45%, #fffcf3), ${hue} 60%, color-mix(in srgb, ${hue} 75%, #1a120a))`
              : 'var(--neu-bg)',
            boxShadow: 'inset 1px 1.5px 2px rgba(255,255,255,0.45), 3px 5px 10px var(--neu-lo)',
            transform: settled && value === 'Completed' ? 'scale(1.08)' : undefined,
          }}
        />
      </div>
      <div className="mt-1.5 flex justify-between px-1.5">
        {DETENTS.map((d) => {
          const active = value === d.value;
          return (
            <button
              key={d.value}
              type="button"
              onClick={() => onChange(d.value)}
              className={`text-[10px] font-bold uppercase tracking-[0.08em] transition-colors ${
                active ? '' : 'text-ink-faint'
              }`}
              style={active ? { color: HUES[d.value] ?? 'var(--color-ink)' } : undefined}
            >
              {d.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
