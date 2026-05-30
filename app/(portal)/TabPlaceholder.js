import Link from 'next/link';

// Lightweight "designed, not built yet" surface so every tab routes cleanly
// during the staged rollout. Replaced tab-by-tab per claude-design-overhaul.md.
export default function TabPlaceholder({ icon: Icon, title, blurb, stage, legacyHref }) {
  return (
    <div className="portal-rise flex min-h-[60vh] flex-col items-center justify-center text-center">
      <span className="flex h-16 w-16 items-center justify-center rounded-3xl border border-sand bg-cream-dim text-terracotta shadow-card">
        <Icon className="h-7 w-7" strokeWidth={1.8} />
      </span>
      <p className="mt-5 text-xs font-semibold uppercase tracking-[0.18em] text-ink-faint">
        {stage}
      </p>
      <h1 className="mt-1.5 font-display text-3xl font-semibold tracking-tight text-ink">
        {title}
      </h1>
      <p className="mt-2 max-w-xs text-sm text-ink-soft">{blurb}</p>
      {legacyHref && (
        <Link
          href={legacyHref}
          className="mt-6 rounded-full bg-ink px-5 py-2.5 text-sm font-semibold text-cream shadow-card transition-transform active:scale-[0.98]"
        >
          Use the current version →
        </Link>
      )}
    </div>
  );
}
