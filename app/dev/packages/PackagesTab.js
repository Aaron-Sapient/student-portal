'use client';

import { useEffect, useState } from 'react';
import { useDevData } from '@/app/developer/(panel)/DevDataContext';
import { PageHeader, TabSkeleton, ErrorNote } from '@/app/developer/(panel)/devUi';
import PackageBuilder from './PackageBuilder';
import PricingDashboard from './PricingDashboard';
import SavedQuotes from './SavedQuotes';

const VIEWS = [
  { key: 'build', label: 'Build proposal' },
  { key: 'pricing', label: 'Pricing' },
  { key: 'saved', label: 'Saved' },
];

// Segmented control — one neumorphic inset track, the active segment raised.
function Segmented({ view, setView }) {
  return (
    <div className="neu-inset mb-6 inline-flex rounded-full p-1">
      {VIEWS.map((v) => (
        <button
          key={v.key}
          type="button"
          onClick={() => setView(v.key)}
          className={`rounded-full px-4 py-1.5 text-[13px] font-semibold transition-all active:scale-[0.97] ${
            view === v.key ? 'neu-raised text-terracotta-deep' : 'text-ink-faint'
          }`}
        >
          {v.label}
        </button>
      ))}
    </div>
  );
}

// The Packages surface: build a proposal email for a family, tune the pricing
// the proposal reads, or browse saved proposals. The pricing config (Supabase,
// via DevDataContext) backs all three; it falls back to defaults if the table
// isn't provisioned yet, so the builder works immediately.
export default function PackagesTab() {
  const { pricing, ensure, refresh } = useDevData();
  useEffect(() => ensure('pricing'), [ensure]);
  const [view, setView] = useState('build');

  return (
    <div>
      <PageHeader eyebrow="Proposals" title="Packages">
        <p className="mt-2 max-w-xl text-[13px] leading-relaxed text-ink-soft">
          Build a pricing-proposal email for a prospective family, adjust the prices and
          discounts behind it, or revisit a saved proposal.
        </p>
      </PageHeader>

      <Segmented view={view} setView={setView} />

      {pricing.error ? (
        <ErrorNote message={pricing.error} onRetry={() => refresh('pricing')} />
      ) : !pricing.data ? (
        <TabSkeleton rows={4} />
      ) : view === 'pricing' ? (
        <PricingDashboard config={pricing.data} onSaved={() => refresh('pricing')} />
      ) : view === 'saved' ? (
        <SavedQuotes />
      ) : (
        <PackageBuilder config={pricing.data} />
      )}
    </div>
  );
}
