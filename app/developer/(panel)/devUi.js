'use client';

import { createPortal } from 'react-dom';

// Shared primitives for the dev portal tabs — neumorphic styling via the
// portal tokens (the .dev-root scope retints the accent to moss).

export function PageHeader({ eyebrow, title, children }) {
  return (
    <header className="portal-rise mb-7" style={{ animationDelay: '0ms' }}>
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-ink-faint">
        {eyebrow}
      </p>
      <h1 className="mt-1.5 font-display text-[2.2rem] font-semibold leading-[1.05] tracking-tight text-ink">
        {title}
        <span className="text-terracotta">.</span>
      </h1>
      {children}
    </header>
  );
}

export function Card({ children, className = '', delay = 90 }) {
  return (
    <section
      className={`portal-rise neu-raised rounded-[1.75rem] p-5 sm:p-6 ${className}`}
      style={{ animationDelay: `${delay}ms` }}
    >
      {children}
    </section>
  );
}

export function PillButton({ children, tone = 'accent', className = '', ...props }) {
  const tones = {
    accent: 'bg-terracotta text-paper',
    ink: 'bg-ink text-cream',
  };
  return (
    <button
      {...props}
      className={`rounded-full px-4 py-2 text-[13px] font-semibold transition-all active:scale-[0.97] disabled:cursor-default disabled:opacity-50 ${tones[tone]} ${className}`}
    >
      {children}
    </button>
  );
}

export function GhostButton({ children, className = '', ...props }) {
  return (
    <button
      {...props}
      className={`neu-chip rounded-full px-4 py-2 text-[13px] font-semibold text-ink-soft transition-all active:scale-[0.97] disabled:cursor-default disabled:opacity-50 ${className}`}
    >
      {children}
    </button>
  );
}

// Toggle chip (replaces the old checkboxes): filled when on.
export function Chip({ on, children, ...props }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      {...props}
      className={`rounded-full px-3.5 py-1.5 text-[12px] font-semibold transition-all active:scale-[0.96] ${
        on ? 'neu-raised text-terracotta-deep' : 'neu-inset text-ink-faint'
      }`}
    >
      {children}
    </button>
  );
}

export const INPUT_CLS =
  'neu-inset rounded-xl bg-transparent px-3 py-2 text-[13px] text-ink outline-none placeholder:text-ink-faint';

// Small numeric field: centered digits, no spinner buttons (they shove the
// centered value off-axis — type the number instead).
export const NUM_INPUT_CLS = `${INPUT_CLS} w-16 shrink-0 text-center [-moz-appearance:textfield] [&::-webkit-inner-spin-button]:hidden [&::-webkit-outer-spin-button]:hidden`;

export function SearchInput(props) {
  return (
    <input
      type="search"
      {...props}
      className={`${INPUT_CLS} min-w-[200px] rounded-full px-4`}
    />
  );
}

export function Badge({ tone = 'muted', children }) {
  const tones = {
    moss: 'bg-moss/[0.14] text-moss',
    ochre: 'bg-ochre/[0.14] text-ochre',
    accent: 'bg-terracotta/[0.1] text-terracotta-deep',
    muted: 'bg-ink-faint/[0.12] text-ink-soft',
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-[10px] font-bold uppercase leading-none tracking-[0.1em] ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

// Rendered into document.body via portal: an ancestor with a transform (e.g.
// a .portal-rise card mid-animation) would otherwise become the containing
// block for `fixed` and drag the dialog down the page. The wrapper re-applies
// `portal-root dev-root` because the neu/accent CSS vars are scoped to those
// classes — outside them `--neu-bg` is undefined and the card paints
// transparent.
export function Modal({ onClose, children }) {
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      className="portal-root dev-root fixed inset-0 z-50 flex items-center justify-center bg-ink/40 px-4 py-8 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="neu-raised w-full max-w-md rounded-[1.75rem] bg-cream p-6"
      >
        {children}
      </div>
    </div>,
    document.body
  );
}

export function EmptyNote({ children }) {
  return <p className="text-[13px] text-ink-soft">{children}</p>;
}

export function TabSkeleton({ rows = 4 }) {
  return (
    <div className="space-y-3">
      <div className="portal-skeleton h-3 w-28 rounded-full" />
      <div className="portal-skeleton h-10 w-56 rounded-2xl" />
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="portal-skeleton h-[64px] rounded-2xl" />
      ))}
    </div>
  );
}

export function ErrorNote({ message, onRetry }) {
  return (
    <div className="portal-rise neu-inset flex items-center justify-between gap-3 rounded-2xl p-4">
      <p className="text-[13px] text-ink-soft">{message}</p>
      {onRetry && (
        <GhostButton onClick={onRetry} className="shrink-0">
          Retry
        </GhostButton>
      )}
    </div>
  );
}
