'use client';

import { useMemo, useState } from 'react';
import { DateTime } from 'luxon';
import {
  Card,
  Chip,
  GhostButton,
  INPUT_CLS,
  PillButton,
} from '@/app/developer/(panel)/devUi';
import { ADDON_DEFS, GRADES, PACKAGES, PACKAGE_LABELS } from '@/lib/pricingSchema';
import { computeQuote, money } from '@/lib/pricingCalc';
import { buildEmail } from '@/lib/packageEmail';

const SEASONS = ['summer', 'fall', 'winter', 'spring'];
const SEASON_GRADES = ['9', '10', '11', '12'];

const emptySel = () =>
  Object.fromEntries(ADDON_DEFS.map((d) => [d.key, d.kind === 'flat' ? false : 0]));

function makeInitial() {
  const expires = DateTime.now().setZone('America/Los_Angeles').plus({ days: 7 }).toFormat('yyyy-MM-dd');
  return {
    firstName: '',
    lastName: '',
    grade: '11',
    gender: 'male',
    discountExpires: expires,
    seasons: [
      { grade: '11', season: 'summer' },
      { grade: '11', season: 'fall' },
    ],
    referral: false,
    sibling: false,
    customPct: 0,
    services: { essential: emptySel(), comprehensive: emptySel(), vip: emptySel() },
    bonuses: { essential: emptySel(), comprehensive: emptySel(), vip: emptySel() },
  };
}

function CountInput({ value, onChange }) {
  return (
    <input
      type="number"
      min={0}
      value={value}
      onChange={(e) => onChange(e.target.value === '' ? 0 : Number(e.target.value))}
      className={`${INPUT_CLS} w-14 text-center [-moz-appearance:textfield] [&::-webkit-inner-spin-button]:hidden [&::-webkit-outer-spin-button]:hidden`}
    />
  );
}

const labelCls = 'text-[12px] font-semibold uppercase tracking-[0.14em] text-ink-faint';
const fieldCls = `${INPUT_CLS} w-full`;

// Per-package selection grid (services or bonuses). Rows = add-ons, columns =
// the three packages; cells are a count field or a Yes/— toggle.
function AddOnGrid({ title, hint, sel, onChange }) {
  return (
    <Card delay={120}>
      <div className="mb-3">
        <h3 className="font-display text-[15px] font-semibold text-ink">{title}</h3>
        {hint && <p className="mt-0.5 text-[12px] leading-snug text-ink-faint">{hint}</p>}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-ink-faint">
              <th className="py-1 text-left font-medium">Service</th>
              {PACKAGES.map((p) => (
                <th key={p} className="px-2 py-1 text-center font-medium">
                  {PACKAGE_LABELS[p]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ADDON_DEFS.map((d) => (
              <tr key={d.key} className="border-t border-sand">
                <td className="py-2 pr-2 text-ink-soft">{d.label}</td>
                {PACKAGES.map((p) => (
                  <td key={p} className="px-2 py-1.5 text-center">
                    {d.kind === 'flat' ? (
                      <Chip on={!!sel[p][d.key]} onClick={() => onChange(p, d.key, !sel[p][d.key])}>
                        {sel[p][d.key] ? 'Yes' : '—'}
                      </Chip>
                    ) : (
                      <CountInput value={sel[p][d.key]} onChange={(v) => onChange(p, d.key, v)} />
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// Live proposal builder: configure a family + per-package recommendations, see
// the three totals update, preview the email, then copy it (rich HTML for
// Gmail) or save it as a record.
export default function PackageBuilder({ config }) {
  const [f, setF] = useState(makeInitial);
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const set = (key, value) => setF((s) => ({ ...s, [key]: value }));
  const setSeason = (i, key, value) =>
    setF((s) => ({ ...s, seasons: s.seasons.map((x, j) => (j === i ? { ...x, [key]: value } : x)) }));
  const setSel = (bucket) => (pkg, key, value) =>
    setF((s) => ({ ...s, [bucket]: { ...s[bucket], [pkg]: { ...s[bucket][pkg], [key]: value } } }));

  const state = useMemo(
    () => ({
      firstName: f.firstName,
      lastName: f.lastName,
      grade: f.grade,
      gender: f.gender,
      discountExpires: f.discountExpires,
      seasons: f.seasons,
      discounts: { referral: f.referral, sibling: f.sibling, custom: (Number(f.customPct) || 0) / 100 },
      services: f.services,
      bonuses: f.bonuses,
    }),
    [f]
  );

  const quote = useMemo(() => computeQuote(state, config), [state, config]);
  const email = useMemo(() => buildEmail(state, config), [state, config]);

  const copy = async () => {
    try {
      if (navigator.clipboard && window.ClipboardItem) {
        await navigator.clipboard.write([
          new window.ClipboardItem({
            'text/html': new Blob([email.html], { type: 'text/html' }),
            'text/plain': new Blob([email.text], { type: 'text/plain' }),
          }),
        ]);
      } else {
        await navigator.clipboard.writeText(email.text);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch (e) {
      alert('Copy failed: ' + e.message);
    }
  };

  const save = async () => {
    setSaving(true);
    setSaved(false);
    try {
      const res = await fetch('/api/developer/packageQuotes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          studentName: `${f.firstName} ${f.lastName}`.trim(),
          grade: f.grade,
          selection: state,
          emailHtml: email.html,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert('Save failed: ' + (data.error || 'unknown'));
        return;
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2200);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      {/* Family + framing */}
      <Card delay={60}>
        <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
          <label className="block">
            <span className={labelCls}>First name</span>
            <input className={`${fieldCls} mt-1.5`} value={f.firstName} onChange={(e) => set('firstName', e.target.value)} />
          </label>
          <label className="block">
            <span className={labelCls}>Last name</span>
            <input className={`${fieldCls} mt-1.5`} value={f.lastName} onChange={(e) => set('lastName', e.target.value)} />
          </label>
          <label className="block">
            <span className={labelCls}>Grade</span>
            <select className={`${fieldCls} mt-1.5 cursor-pointer`} value={f.grade} onChange={(e) => set('grade', e.target.value)}>
              {GRADES.map((g) => (
                <option key={g} value={g}>
                  {g}th
                </option>
              ))}
            </select>
          </label>
          <div className="block">
            <span className={labelCls}>Gender (pronouns)</span>
            <div className="mt-1.5 flex gap-2">
              <Chip on={f.gender === 'male'} onClick={() => set('gender', 'male')}>
                He / him
              </Chip>
              <Chip on={f.gender === 'female'} onClick={() => set('gender', 'female')}>
                She / her
              </Chip>
            </div>
          </div>
          <label className="block">
            <span className={labelCls}>Discount expires</span>
            <input type="date" className={`${fieldCls} mt-1.5`} value={f.discountExpires} onChange={(e) => set('discountExpires', e.target.value)} />
          </label>
          <div className="block">
            <span className={labelCls}>Discounts</span>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <Chip on={f.referral} onClick={() => set('referral', !f.referral)}>
                Referral
              </Chip>
              <Chip on={f.sibling} onClick={() => set('sibling', !f.sibling)}>
                Sibling
              </Chip>
              <label className="flex items-center gap-1.5 text-[12px] text-ink-soft">
                Custom
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={f.customPct}
                  onChange={(e) => set('customPct', e.target.value === '' ? 0 : Number(e.target.value))}
                  className={`${INPUT_CLS} w-14 text-right [-moz-appearance:textfield] [&::-webkit-inner-spin-button]:hidden [&::-webkit-outer-spin-button]:hidden`}
                />
                %
              </label>
            </div>
          </div>
        </div>

        {/* Seasons to highlight */}
        <div className="mt-5 border-t border-sand pt-4">
          <span className={labelCls}>Seasons to highlight</span>
          <div className="mt-2 flex flex-wrap gap-3">
            {f.seasons.map((s, i) => (
              <div key={i} className="flex items-center gap-2">
                <select className={`${INPUT_CLS} cursor-pointer`} value={s.grade} onChange={(e) => setSeason(i, 'grade', e.target.value)}>
                  {SEASON_GRADES.map((g) => (
                    <option key={g} value={g}>
                      {g}th
                    </option>
                  ))}
                </select>
                <select className={`${INPUT_CLS} cursor-pointer`} value={s.season} onChange={(e) => setSeason(i, 'season', e.target.value)}>
                  {SEASONS.map((se) => (
                    <option key={se} value={se}>
                      {se}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </div>
      </Card>

      {/* Totals strip */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {PACKAGES.map((p) => {
          const P = quote.packages[p];
          return (
            <div key={p} className="neu-raised rounded-[1.5rem] p-4">
              <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
                {PACKAGE_LABELS[p]}
              </p>
              <p className="mt-1 font-display text-[1.8rem] font-semibold leading-none text-ink">
                {money(P.total)}
              </p>
              <p className="mt-1.5 text-[12px] text-ink-soft">
                {money(P.subtotal)} − {money(P.totalDiscount)} ({P.totalDiscountPct}%)
              </p>
              {P.bonusTotal > 0 && (
                <p className="text-[12px] text-moss">+ {money(P.bonusTotal)} in bonuses</p>
              )}
            </div>
          );
        })}
      </div>

      <AddOnGrid
        title="Recommended services"
        hint="What you’re recommending for each package tier. Counts for colleges/projects, toggles for the rest."
        sel={f.services}
        onChange={setSel('services')}
      />

      <AddOnGrid
        title="Sign-on bonuses"
        hint="Services you’re including free as a sign-on perk. The early-start bonus is added automatically in season."
        sel={f.bonuses}
        onChange={setSel('bonuses')}
      />

      {/* Email preview + actions */}
      <Card delay={150}>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-display text-[15px] font-semibold text-ink">Proposal email</h3>
          <div className="flex items-center gap-2">
            {copied && <span className="text-[12px] font-medium text-moss">Copied.</span>}
            {saved && <span className="text-[12px] font-medium text-moss">Saved.</span>}
            <GhostButton onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save proposal'}
            </GhostButton>
            <PillButton onClick={copy}>Copy for Gmail</PillButton>
          </div>
        </div>
        <div className="neu-inset max-h-[28rem] overflow-y-auto rounded-2xl p-4">
          {email.blocks.map((b, i) => {
            if (b.kind === 'spacer') return <div key={i} className="h-3" />;
            const cls =
              b.kind === 'h1'
                ? 'font-display text-[15px] font-semibold text-ink'
                : b.kind === 'h2'
                ? 'font-display text-[14px] font-semibold text-ink'
                : b.kind === 'h3'
                ? 'text-[13px] font-semibold text-ink'
                : 'text-[13px] text-ink-soft';
            return (
              <p key={i} className={`whitespace-pre-wrap leading-relaxed ${cls}`}>
                {b.text}
              </p>
            );
          })}
        </div>
      </Card>
    </div>
  );
}
