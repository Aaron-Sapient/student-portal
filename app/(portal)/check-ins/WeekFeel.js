'use client';

import { useState } from 'react';

// "How'd the week go?" — the interactive clay blob from the habit tracker's
// check-in ritual, retold in the portal palette. The slider runs 0–100 so the
// clay morphs smoothly; feelToRating collapses it to the backend's 1–10 scale.
// Low = a heavy plum lump pressed under a thumbprint; mid = resting linen
// clay; high = the clay blooms terracotta with orbiting petals. The blob is
// also pressable (pointerdown squishes, release springs back).

const LOW = [122, 113, 134];
const MID = [205, 191, 168];
const HIGH = [198, 97, 63]; // portal terracotta
const LABELS = ['Rough week', 'Tough week', 'Okay week', 'Good week', 'Great week'];
const PETALS = [0, 72, 144, 216, 288];

const lerp = (a, b, t) => a + (b - a) * t;
const mix = (c1, c2, t) => c1.map((x, i) => Math.round(lerp(x, c2[i], t)));
const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;

// Collapse the 0–100 slider into the check-in's 1–10 self-rating.
export const feelToRating = (v) => Math.min(10, Math.max(1, Math.ceil(v / 10) || 1));

export default function WeekFeel({ value, onChange }) {
  const [press, setPress] = useState(0);
  // Inline transition override for the squish: fast flatten on press, springy
  // overshoot on release. null = the calm CSS ease while sliding.
  const [curve, setCurve] = useState(null);

  const t = value / 100;
  const splat = Math.max(0, 1 - t / 0.22); // 1 at the very bottom → 0 by ~22%
  const c = t < 0.5 ? mix(LOW, MID, t * 2) : mix(MID, HIGH, (t - 0.5) * 2);
  const bloom = Math.max(0, (t - 0.55) / 0.45);
  let lite = mix(c, [255, 252, 243], 0.45);
  if (bloom > 0) lite = mix(lite, [255, 235, 180], bloom * 0.6);
  const deep = mix(c, [60, 45, 35], 0.25);

  // droop at the low end: squash + lumpy radius; round out as it lifts
  const squash = Math.max(0, 0.35 - t * 0.7);
  const sx = (1 + splat * 0.18) * (1 + press * 0.05);
  const sy = (1 - squash * 0.45 - splat * 0.08) * (1 - press * 0.09);
  const lump = Math.max(0, 1 - t * 2);
  const dip = Math.min(1.25, splat * (1 + press * 0.25));
  // silhouette: lumpy when low; under splat the crown settles and the base
  // swells — every vertical radius stays fat so the shoulders never turn sharp.
  const borderRadius =
    lump > 0.02
      ? `${46 + lump * 6}% ${54 - lump * 6}% ${52 + lump * 4}% ${48 - lump * 4}% / ` +
        `${58 + lump * 6 - dip * 16}% ${56 - lump * 8 - dip * 10}% ${44 + lump * 8 + dip * 10}% ${42 - lump * 6 + dip * 12}%`
      : '50%';

  // mood wash over the step card: deeper plum + more alpha on the low side —
  // the raw LOW grey sits too close to the canvas to register otherwise.
  const moodC = t < 0.5 ? mix([104, 88, 138], MID, t * 2) : mix(MID, HIGH, (t - 0.5) * 2);
  const moodA = Math.pow(Math.abs(t - 0.5) * 2, 1.3) * (t < 0.5 ? 0.3 : 0.18);

  const squishTrans = curve
    ? { transition: `transform ${curve}, border-radius ${curve}` }
    : undefined;

  function handleInput(e) {
    let v = +e.target.value;
    // neutral magnet: a ±2.5 dead-zone around 50 grabs the thumb into the notch
    if (Math.abs(v - 50) <= 2.5) v = 50;
    setCurve(null); // back to the calm CSS ease while sliding
    onChange(v);
  }

  function pressDown(e) {
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setCurve('0.09s ease-out');
    setPress(1);
  }
  function pressUp() {
    if (!press) return;
    setCurve('0.55s cubic-bezier(0.3, 2.1, 0.36, 0.82)');
    setPress(0);
  }

  return (
    <div className="relative">
      {/* the blob's colour breathed over the card — nothing at neutral */}
      <div
        aria-hidden
        className="pointer-events-none absolute -inset-10"
        style={{
          background: `radial-gradient(120% 95% at 50% 22%, rgba(${moodC.join(',')},${moodA.toFixed(3)}), transparent 75%)`,
          // -inset-10 outruns the radial fade, so the overlay's top edge lands
          // mid-card with visible alpha — a hard line. Feather it instead.
          WebkitMaskImage: 'linear-gradient(to bottom, transparent, black 72px)',
          maskImage: 'linear-gradient(to bottom, transparent, black 72px)',
        }}
      />
      <div className="relative flex flex-col items-center gap-5 pt-2">
        <div
          className="relative flex h-[190px] w-[190px] cursor-pointer touch-none select-none items-center justify-center"
          onPointerDown={pressDown}
          onPointerUp={pressUp}
          onPointerCancel={pressUp}
        >
          <span className="feel-ripple" />
          <span className="feel-ripple" style={{ animationDelay: '2.4s' }} />
          <span className="feel-ripple" style={{ animationDelay: '4.8s' }} />
          <div className={`feel-breathe ${splat > 0.5 ? 'heavy' : ''}`}>
            <div className="feel-petal-ring">
              {PETALS.map((a, i) => {
                const s = Math.max(0, Math.min(1, bloom * 1.25 - i * 0.045));
                return (
                  <span
                    key={a}
                    className="feel-petal"
                    style={{
                      transform: `rotate(${a}deg) translateY(-${46 + bloom * 8}px) scale(${s})`,
                      opacity: s,
                    }}
                  />
                );
              })}
            </div>
            <div
              className="feel-core"
              style={{
                background: `radial-gradient(circle at 34% 28%, ${rgb(lite)}, ${rgb(c)} ${bloom > 0 ? 62 : 58}%, ${rgb(deep)})`,
                transform: `translateY(${(squash * 16 + splat * 6 + press * 8).toFixed(1)}px) scale(${sx.toFixed(3)}, ${sy.toFixed(3)})`,
                borderRadius,
                ...squishTrans,
              }}
            >
              <div
                className="feel-dent"
                style={{
                  opacity: Math.min(1, splat * 1.5).toFixed(3),
                  transform: `translateY(${(splat * 13 + press * 3).toFixed(1)}px) scale(${(0.58 + splat * 0.32 + press * splat * 0.2).toFixed(3)}, ${(0.55 + splat * 0.55 + press * splat * 0.45).toFixed(3)})`,
                  ...(curve ? { transition: `transform ${curve}, opacity 0.3s ease` } : undefined),
                }}
              />
            </div>
          </div>
        </div>

        <p className="font-display text-2xl font-semibold tracking-tight text-ink">
          {LABELS[Math.min(4, Math.floor(t * 5))]}
        </p>

        <div className="w-full px-1 pb-1">
          <div className="neu-inset relative h-[26px] rounded-full" style={{ isolation: 'isolate' }}>
            <span aria-hidden className="feel-notch" />
            <input
              type="range"
              min={0}
              max={100}
              value={value}
              onChange={handleInput}
              aria-label="How the week went"
              className="feel-range"
            />
          </div>
          <div className="mt-2 flex justify-between text-[10px] font-bold uppercase tracking-[0.14em] text-ink-faint">
            <span>Rough</span>
            <span>Great</span>
          </div>
        </div>
      </div>
    </div>
  );
}
