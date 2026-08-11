'use client';

import { useEffect, useState } from 'react';
import { useDevData } from '@/app/developer/(panel)/DevDataContext';
import { PageHeader, TabSkeleton, ErrorNote } from '@/app/developer/(panel)/devUi';
import PackageBuilder, { fromSelection, makeInitial } from './PackageBuilder';
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
  // The builder's form lives here because the views are conditionally rendered:
  // state held inside PackageBuilder is destroyed by a trip to Pricing or
  // Saved. It also gives the Saved tab somewhere to hand a reopened proposal.
  const [form, setForm] = useState(makeInitial);

  // Reopening REPLACES the builder's form. Lifting the state up made a
  // half-built proposal survive a tab switch; it also made this the one click
  // that can destroy one, so an occupied form asks first. "Occupied" is
  // measured against a pristine form rather than against the name fields —
  // add-ons and discounts are work too.
  const openInBuilder = (selection, sourceQuote) => {
    const dirty = JSON.stringify(form) !== JSON.stringify(makeInitial());
    if (dirty && !window.confirm('Replace the proposal currently in the builder? Unsaved changes will be lost.')) {
      return;
    }
    // sourceQuote carries the row's id, so saving edits THIS proposal rather
    // than whichever row happens to share the student's name.
    setForm(fromSelection(selection, sourceQuote));
    setView('build');
  };

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
        <SavedQuotes onOpenInBuilder={openInBuilder} />
      ) : (
        <PackageBuilder config={pricing.data} form={form} setForm={setForm} />
      )}
    </div>
  );
}
