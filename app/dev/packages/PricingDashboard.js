'use client';

import { useState } from 'react';
import {
  Card,
  GhostButton,
  INPUT_CLS,
  PillButton,
} from '@/app/developer/(panel)/devUi';
import {
  ADDON_DEFS,
  DEFAULT_PRICING,
  GRADES,
  PACKAGES,
  PACKAGE_LABELS,
  validatePricing,
} from '@/lib/pricingSchema';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const clone = (v) => (typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)));

function setIn(obj, path, value) {
  const next = clone(obj);
  let cur = next;
  for (let i = 0; i < path.length - 1; i++) cur = cur[path[i]];
  cur[path[path.length - 1]] = value;
  return next;
}

function Num({ value, onChange, width = 'w-24', prefix }) {
  return (
    <span className="relative inline-flex items-center">
      {prefix && <span className="pointer-events-none absolute left-2.5 text-[12px] text-ink-faint">{prefix}</span>}
      <input
        type="number"
        min={0}
        value={value}
        onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
        className={`${INPUT_CLS} ${width} text-right [-moz-appearance:textfield] [&::-webkit-inner-spin-button]:hidden [&::-webkit-outer-spin-button]:hidden ${
          prefix ? 'pl-6' : ''
        }`}
      />
    </span>
  );
}

function MonthSelect({ value, onChange }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className={`${INPUT_CLS} cursor-pointer pr-2`}
    >
      {MONTHS.map((m, i) => (
        <option key={m} value={i + 1}>
          {m}
        </option>
      ))}
    </select>
  );
}

function SectionTitle({ children, hint }) {
  return (
    <div className="mb-3">
      <h3 className="font-display text-[15px] font-semibold text-ink">{children}</h3>
      {hint && <p className="mt-0.5 text-[12px] leading-snug text-ink-faint">{hint}</p>}
    </div>
  );
}

// No-code editor for everything the proposal's pricing reads. Saves the whole
// config as one row (Supabase) via /api/developer/pricing; the builder reads it
// live, so edits take effect on the next proposal with no redeploy.
export default function PricingDashboard({ config, onSaved }) {
  const [cfg, setCfg] = useState(() => clone(config));
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(false);

  const up = (path, value) => setCfg((c) => setIn(c, path, value));

  const error = validatePricing(cfg);
  const dirty = JSON.stringify(cfg) !== JSON.stringify(config);

  const save = async () => {
    if (error) return;
    setSaving(true);
    setSavedAt(false);
    try {
      const res = await fetch('/api/developer/pricing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: cfg }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert('Save failed: ' + (data.error || 'unknown'));
        return;
      }
      setSavedAt(true);
      onSaved?.();
    } finally {
      setSaving(false);
    }
  };

  const flatAddOns = ADDON_DEFS.filter((d) => d.kind !== 'perPackageCount');

  return (
    <div className="space-y-5">
      {/* Base package prices */}
      <Card delay={60}>
        <SectionTitle hint="Starting price for each package at each grade level.">
          Base package price
        </SectionTitle>
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-ink-faint">
                <th className="py-1 text-left font-medium">Grade</th>
                {PACKAGES.map((p) => (
                  <th key={p} className="px-2 py-1 text-right font-medium">
                    {PACKAGE_LABELS[p]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {GRADES.map((g) => (
                <tr key={g} className="border-t border-sand">
                  <td className="py-2 font-semibold text-ink">{g}th</td>
                  {PACKAGES.map((p) => (
                    <td key={p} className="px-2 py-2 text-right">
                      <Num value={cfg.base[g][p]} onChange={(v) => up(['base', g, p], v)} prefix="$" />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Add-on prices */}
      <Card delay={90}>
        <SectionTitle hint="À-la-carte service costs. Extra Colleges is priced per school and differs by package.">
          Add-on service prices
        </SectionTitle>

        <div className="mb-4">
          <p className="mb-1.5 text-[13px] font-semibold text-ink">Extra Colleges (per school)</p>
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            {PACKAGES.map((p) => (
              <label key={p} className="flex items-center gap-2 text-[13px] text-ink-soft">
                {PACKAGE_LABELS[p]}
                <Num value={cfg.addOns.extraCollege[p]} onChange={(v) => up(['addOns', 'extraCollege', p], v)} prefix="$" width="w-20" />
              </label>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-x-8 gap-y-1.5 sm:grid-cols-2">
          {flatAddOns.map((d) => (
            <label key={d.key} className="flex items-center justify-between gap-3 py-1 text-[13px]">
              <span className="text-ink-soft">
                {d.label}
                {d.kind === 'count' && <span className="text-[11px] text-ink-faint"> (per unit)</span>}
              </span>
              <Num value={cfg.addOns[d.key]} onChange={(v) => up(['addOns', d.key], v)} prefix="$" width="w-24" />
            </label>
          ))}
        </div>
      </Card>

      {/* Discount rates */}
      <Card delay={120}>
        <SectionTitle hint="The automatic per-add-on discount plus the referral / sibling rates and the early-start hourly basis.">
          Discount rates
        </SectionTitle>
        <div className="grid grid-cols-1 gap-x-8 gap-y-2 sm:grid-cols-2">
          <label className="flex items-center justify-between gap-3 py-1 text-[13px] text-ink-soft">
            Per add-on discount
            <Num value={cfg.discounts.perAddOnPct} onChange={(v) => up(['discounts', 'perAddOnPct'], v)} width="w-16" prefix="%" />
          </label>
          <label className="flex items-center justify-between gap-3 py-1 text-[13px] text-ink-soft">
            Referral discount
            <Num value={cfg.discounts.referralPct} onChange={(v) => up(['discounts', 'referralPct'], v)} width="w-16" prefix="%" />
          </label>
          <label className="flex items-center justify-between gap-3 py-1 text-[13px] text-ink-soft">
            Sibling discount
            <Num value={cfg.discounts.siblingPct} onChange={(v) => up(['discounts', 'siblingPct'], v)} width="w-16" prefix="%" />
          </label>
          <label className="flex items-center justify-between gap-3 py-1 text-[13px] text-ink-soft">
            Early-start rate (per hr)
            <Num value={cfg.discounts.earlyStartRate} onChange={(v) => up(['discounts', 'earlyStartRate'], v)} width="w-20" prefix="$" />
          </label>
        </div>
      </Card>

      {/* Late-start discount windows */}
      <Card delay={150}>
        <SectionTitle hint="A discount applied to each package during off-season months. Set $0 for the peak season.">
          Late-start discount (seasonal)
        </SectionTitle>
        <div className="space-y-4">
          {cfg.lateStart.map((w, i) => (
            <div key={i} className="neu-inset rounded-2xl p-3.5">
              <div className="mb-2.5 flex flex-wrap items-center gap-2 text-[13px] text-ink-soft">
                <span className="font-semibold text-ink">{w.label || `Window ${i + 1}`}</span>
                <span className="text-ink-faint">·</span>
                <MonthSelect value={w.startMonth} onChange={(v) => up(['lateStart', i, 'startMonth'], v)} />
                <span className="text-ink-faint">to</span>
                <MonthSelect value={w.endMonth} onChange={(v) => up(['lateStart', i, 'endMonth'], v)} />
              </div>
              <div className="flex flex-wrap gap-x-6 gap-y-2">
                {PACKAGES.map((p) => (
                  <label key={p} className="flex items-center gap-2 text-[13px] text-ink-soft">
                    {PACKAGE_LABELS[p]}
                    <Num value={w[p]} onChange={(v) => up(['lateStart', i, p], v)} prefix="$" width="w-20" />
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* Early-start bonus window */}
      <Card delay={180}>
        <SectionTitle hint="When today falls in this window, the weeks of free service before the target date become a bonus (× the per-package multiplier).">
          Early-start bonus window
        </SectionTitle>
        <div className="space-y-3 text-[13px] text-ink-soft">
          <div className="flex flex-wrap items-center gap-2">
            <span>Applies</span>
            <MonthSelect value={cfg.earlyStart.applyStartMonth} onChange={(v) => up(['earlyStart', 'applyStartMonth'], v)} />
            <Num value={cfg.earlyStart.applyStartDay} onChange={(v) => up(['earlyStart', 'applyStartDay'], v)} width="w-14" />
            <span>through</span>
            <MonthSelect value={cfg.earlyStart.applyEndMonth} onChange={(v) => up(['earlyStart', 'applyEndMonth'], v)} />
            <Num value={cfg.earlyStart.applyEndDay} onChange={(v) => up(['earlyStart', 'applyEndDay'], v)} width="w-14" />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span>Free service counted until</span>
            <MonthSelect value={cfg.earlyStart.targetMonth} onChange={(v) => up(['earlyStart', 'targetMonth'], v)} />
            <Num value={cfg.earlyStart.targetDay} onChange={(v) => up(['earlyStart', 'targetDay'], v)} width="w-14" />
          </div>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 pt-1">
            <span className="font-semibold text-ink">Multiplier</span>
            {PACKAGES.map((p) => (
              <label key={p} className="flex items-center gap-2">
                {PACKAGE_LABELS[p]}
                <Num value={cfg.earlyStart.multiplier[p]} onChange={(v) => up(['earlyStart', 'multiplier', p], v)} width="w-16" />
              </label>
            ))}
          </div>
        </div>
      </Card>

      {/* Save bar */}
      <div className="flex flex-wrap items-center gap-2.5">
        <PillButton onClick={save} disabled={saving || !!error || !dirty}>
          {saving ? 'Saving…' : 'Save pricing'}
        </PillButton>
        <GhostButton
          onClick={() => setCfg(clone(DEFAULT_PRICING))}
          disabled={saving || JSON.stringify(cfg) === JSON.stringify(DEFAULT_PRICING)}
        >
          Reset to defaults
        </GhostButton>
        {error && <span className="text-[12px] font-medium text-terracotta-deep">{error}</span>}
        {!error && !dirty && savedAt && <span className="text-[12px] font-medium text-moss">Saved.</span>}
      </div>
    </div>
  );
}
