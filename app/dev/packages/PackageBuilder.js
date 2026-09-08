'use client';

import { useMemo, useState } from 'react';
import { DateTime } from 'luxon';
import { useDevData } from '@/app/developer/(panel)/DevDataContext';
import {
  Card,
  Chip,
  GhostButton,
  INPUT_CLS,
  Modal,
  PillButton,
} from '@/app/developer/(panel)/devUi';
import {
  ADDON_DEFS,
  ADDON_PACKAGES,
  DEFAULT_OFFERED,
  DEFAULT_PRESET,
  GRADES,
  LEGACY_OFFERED,
  PACKAGES,
  PACKAGE_LABELS,
  PRICING_PRESETS,
  presetFor,
  resolvePricing,
  studentNameKey,
} from '@/lib/pricingSchema';
import { computeQuote, money } from '@/lib/pricingCalc';
import { buildEmail } from '@/lib/packageEmail';

const SEASONS = ['summer', 'fall', 'winter', 'spring'];
const SEASON_GRADES = ['9', '10', '11', '12'];
const ZONE = 'America/Los_Angeles';

const emptySel = () =>
  Object.fromEntries(ADDON_DEFS.map((d) => [d.key, d.kind === 'flat' ? false : 0]));

export function makeInitial() {
  const expires = DateTime.now().setZone(ZONE).plus({ days: 7 }).toFormat('yyyy-MM-dd');
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
    services: Object.fromEntries(PACKAGES.map((p) => [p, emptySel()])),
    bonuses: Object.fromEntries(PACKAGES.map((p) => [p, emptySel()])),
    // Every new proposal starts explicitly VIP-only, and the Tiers offered
    // control below edits it from there. Because the field is always written, a
    // new row never reaches normalizeSelectedPackages' legacy fallback and
    // never quotes a closed tier by omission.
    selectedPackages: [...DEFAULT_OFFERED],
    // Which pricing card this proposal is priced from. Current by default; the
    // legacy card is an explicit, visible choice, never a fallback.
    pricingPreset: DEFAULT_PRESET,
    // The saved row this form is editing, once there is one: { id, nameKey }.
    // It is the form's IDENTITY, not part of the proposal, so it is excluded
    // from the `state` memo that becomes `selection`. Without it a save can
    // only identify its own row by the student's name — a mutable display
    // string — and "update" then means "whichever row currently has that
    // name", which for two students who share one is a different family's.
    sourceQuote: null,
  };
}

// The inverse of the `state` memo below: a saved proposal's `selection` blob
// back into the form's shape, so "Open in builder" on the Saved tab reopens a
// real, editable proposal. Every field is defaulted against makeInitial()
// because a stored row is only as new as the day it was saved — an add-on key
// added since then is simply absent from its selection maps.
export function fromSelection(sel, sourceQuote = null) {
  const base = makeInitial();
  if (!sel || typeof sel !== 'object') return base;
  base.sourceQuote = sourceQuote;
  const merge = (bucket) =>
    Object.fromEntries(PACKAGES.map((p) => [p, { ...emptySel(), ...(bucket?.[p] || {}) }]));
  // Keep however many seasons were stored — the UI renders one row per entry
  // and buildEmail reads the first two. Reverting to the default pair on an
  // unexpected length would fail to WRONG content rather than to the record.
  const seasons = Array.isArray(sel.seasons) && sel.seasons.length
    ? sel.seasons.map((s, i) => ({ ...(base.seasons[i] || base.seasons[0]), ...s }))
    : base.seasons;
  // An expiry only survives the round trip while it is still in the future.
  // Everything else in the email re-prices to today — the month bonus, the
  // late-start window, the early-start block — so restoring a stale date
  // verbatim is the one thing here that would put a dead deadline ("expires
  // 4/12", three times) in front of a family. ISO dates compare lexically.
  // Reopening restores the card the row was priced on, and the tiers it
  // offered are then filtered to what that card can actually price — a row is
  // only as coherent as the day it was saved, and a tier the active card has no
  // price for would render as somebody else's number under this card's label.
  // Empty after the filter falls back to the card's own default rather than to
  // normalizeSelectedPackages' silent substitution.
  // The row's own field wins; failing that, the card the Saved tab inferred
  // from its config_snapshot; failing that, current. The middle term is what
  // stops a pre-refresh proposal reopening at today's prices.
  const preset = presetFor(sel.pricingPreset || sourceQuote?.pricingPreset);
  const stored = Array.isArray(sel.selectedPackages) ? sel.selectedPackages : [...LEGACY_OFFERED];
  // ONLY a non-default card prunes. The current card can price every member of
  // PACKAGES, so filtering there could only change the outcome for a row whose
  // stored selection is already unrepresentable — an Essential-only proposal —
  // and that one must keep resolving exactly as it did before presets existed
  // (verbatim here, then normalizeSelectedPackages' legacy-pair fallback).
  const pruned = preset.offerPackages.filter((p) => stored.includes(p));
  const storedTiers =
    preset.key === DEFAULT_PRESET ? stored : pruned.length ? pruned : [...preset.defaultOffered];
  const storedExpiry = String(sel.discountExpires || '');
  const keepExpiry =
    /^\d{4}-\d{2}-\d{2}$/.test(storedExpiry) &&
    storedExpiry >= DateTime.now().setZone(ZONE).toISODate();
  return {
    ...base,
    firstName: sel.firstName || '',
    lastName: sel.lastName || '',
    grade: GRADES.includes(String(sel.grade)) ? String(sel.grade) : base.grade,
    gender: sel.gender === 'female' ? 'female' : 'male',
    discountExpires: keepExpiry ? storedExpiry : base.discountExpires,
    seasons,
    referral: !!sel.discounts?.referral,
    sibling: !!sel.discounts?.sibling,
    // Stored as a fraction (0.0333), edited as a percentage (3.33).
    customPct: Math.round((Number(sel.discounts?.custom) || 0) * 10000) / 100,
    services: merge(sel.services),
    bonuses: merge(sel.bonuses),
    // A row saved before the builder wrote this field carries no selection, so
    // it reopens as the legacy pair and becomes explicit on its next save.
    // Carrying a stored selection verbatim is what stops a narrower proposal
    // from silently reopening with tiers the family was never offered.
    selectedPackages: storedTiers,
    // presetFor() never returns undefined, so a row saved before this field
    // existed reopens on the current card — which is what it was priced on.
    pricingPreset: preset.key,
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
// ADDON_PACKAGES, never PACKAGES: UVIP sells and gifts no add-ons, so it gets
// no cell to select one in.
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
              {ADDON_PACKAGES.map((p) => (
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
                {ADDON_PACKAGES.map((p) => (
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
//
// The form state is OWNED BY PackagesTab, not here: the three views are
// conditionally rendered, so a glance at the Pricing tab unmounts this
// component. Holding `f` locally meant a half-built proposal was destroyed by
// a tab switch — and, once the Saved tab could reopen a proposal, silently
// reverted to the saved selection on the way back.
export default function PackageBuilder({ config, form, setForm }) {
  const f = form;
  const setF = setForm;
  const { refresh } = useDevData();
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [savedLabel, setSavedLabel] = useState('Saved.');
  // The existing proposal for this student name, when the server found one.
  const [duplicate, setDuplicate] = useState(null);

  const set = (key, value) => setF((s) => ({ ...s, [key]: value }));
  const setSeason = (i, key, value) =>
    setF((s) => ({ ...s, seasons: s.seasons.map((x, j) => (j === i ? { ...x, [key]: value } : x)) }));
  const setSel = (bucket) => (pkg, key, value) =>
    setF((s) => ({ ...s, [bucket]: { ...s[bucket], [pkg]: { ...s[bucket][pkg], [key]: value } } }));

  // The tiers this proposal presents. Stored in PACKAGES order because the
  // email numbers its options by position, and NEVER emptied: deselecting the
  // last remaining tier is a no-op, because an empty selection has no
  // meaningful rendering and normalizeSelectedPackages would substitute the
  // legacy pair without saying so. This control is where that is prevented.
  const preset = presetFor(f.pricingPreset);
  const tiers = Array.isArray(f.selectedPackages) ? f.selectedPackages : [...DEFAULT_OFFERED];
  const toggleTier = (pkg) =>
    setF((s) => {
      const cur = Array.isArray(s.selectedPackages) ? s.selectedPackages : [...DEFAULT_OFFERED];
      const on = cur.includes(pkg);
      if (on && cur.length === 1) return s;
      return { ...s, selectedPackages: PACKAGES.filter((x) => (x === pkg ? !on : cur.includes(x))) };
    });

  // Switching cards prunes any tier the new card cannot offer, because a
  // selection is only meaningful against the card that prices it — UVIP did not
  // exist in 2025-26. Pruning to empty falls back to the card's own default
  // rather than leaving a selection normalizeSelectedPackages would silently
  // substitute for.
  const setPreset = (key) =>
    setF((s) => {
      const next = presetFor(key);
      const cur = Array.isArray(s.selectedPackages) ? s.selectedPackages : [];
      const kept = next.offerPackages.filter((p) => cur.includes(p));
      return {
        ...s,
        pricingPreset: next.key,
        selectedPackages: kept.length ? kept : [...next.defaultOffered],
      };
    });

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
      // Always populated and never empty: makeInitial() seeds DEFAULT_OFFERED,
      // fromSelection() fills a legacy row's absent selection, and the Tiers
      // offered control refuses to deselect the last tier. So the saved
      // `selection` blob always records which tiers were actually offered.
      // Read straight off `f` rather than through the render-scoped `tiers`, so
      // the memo keeps depending on `f` alone.
      selectedPackages: f.selectedPackages,
      // Saved with the proposal, so a re-render — here, in the contract
      // derivation, or in any later reader — prices from the same card.
      pricingPreset: f.pricingPreset,
    }),
    [f]
  );

  // Every figure on this screen comes from the resolved card, never from
  // `config` directly: `config` is the live row, which is only the current
  // preset's card.
  const activeConfig = useMemo(() => resolvePricing(f.pricingPreset, config), [f.pricingPreset, config]);
  const quote = useMemo(() => computeQuote(state, activeConfig), [state, activeConfig]);
  const email = useMemo(() => buildEmail(state, activeConfig), [state, activeConfig]);

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

  // `intent` is undefined on the first attempt: the server then checks whether
  // a proposal for this student name already exists and answers 409 with it,
  // writing nothing. That answer opens the prompt below, and the user's choice
  // comes back through here as { updateId } or { forceNew: true }.
  const save = async (intent) => {
    const studentName = `${f.firstName} ${f.lastName}`.trim();
    // The open row's id is sent only while the name still refers to it. Rename
    // the student and this is a different proposal, so it goes back through
    // the collision check rather than overwriting the row it came from.
    const source =
      f.sourceQuote && f.sourceQuote.nameKey === studentNameKey(studentName) ? f.sourceQuote.id : undefined;
    setSaving(true);
    setSaved(false);
    try {
      const res = await fetch('/api/developer/packageQuotes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          studentName,
          grade: f.grade,
          selection: state,
          emailHtml: email.html,
          // A save that already knows its row updates it, no prompt: this is
          // the second click of "Save proposal" on the same proposal, which is
          // how two rows for one student appeared within 55 seconds.
          ...(source ? { updateId: source } : {}),
          ...(source ? {} : { sourceId: f.sourceQuote?.id }),
          ...intent,
        }),
      });
      const data = await res.json();
      if (res.status === 409 && (data.duplicate || data.matches)) {
        setDuplicate({ ...(data.duplicate || {}), ambiguous: !data.duplicate, matches: data.matches });
        return;
      }
      if (!res.ok) {
        alert('Save failed: ' + (data.error || 'unknown'));
        return;
      }
      setDuplicate(null);
      // Adopt the row this form now edits, so the NEXT save updates it.
      if (data.quote?.id) {
        setF((s) => ({ ...s, sourceQuote: { id: data.quote.id, nameKey: studentNameKey(studentName) } }));
      }
      setSavedLabel(data.updated ? 'Updated.' : 'Saved.');
      setSaved(true);
      setTimeout(() => setSaved(false), 2200);
      // DevDataContext.ensure() is fetch-once: without this the Saved tab keeps
      // serving the list it loaded earlier in the session, so a proposal saved
      // seconds ago is simply absent from the only surface that can reopen it.
      refresh('packageQuotes');
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
            {/* This date sets the BONUS deadline, not a discount one — it is
                what the intro sentence and the "… Bonus: expires …" heading
                both quote (Aaron, 2026-08-11). Discounts expire too, on their
                own schedule, which this generator does not model; labelling
                this one "Discount expires" invited setting it to the wrong
                date. The state key stays `discountExpires` so stored
                selections keep round-tripping. */}
            <span className={labelCls}>Bonus expires</span>
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
          <div className="block sm:col-span-2">
            {/* Which price card this proposal is built from. Ryan picks it
                per family, because a family already quoted before the
                2026-08-31 refresh keeps the terms they were shown (Aaron's
                ruling 2026-09-08). It is the FIRST control in this card rather
                than a setting elsewhere: it moves every number below it, so
                choosing it after building a proposal is choosing it twice. */}
            <span className={labelCls}>Pricing card</span>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              {Object.values(PRICING_PRESETS).map((pr) => (
                <Chip
                  key={pr.key}
                  on={f.pricingPreset === pr.key}
                  onClick={() => setPreset(pr.key)}
                  title={pr.hint}
                >
                  {pr.label}
                </Chip>
              ))}
            </div>
            {f.pricingPreset !== DEFAULT_PRESET && (
              <p className="mt-2 text-[12px] leading-snug text-terracotta">
                Pricing from the frozen {preset.label} card — for a family who was already quoted
                on it. Everything below, including the installment terms and the pay-in-full
                incentive, is the {preset.label} version.
              </p>
            )}
          </div>

          <div className="block sm:col-span-2">
            <span className={labelCls}>Tiers offered</span>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              {preset.offerPackages.map((pkg) => {
                const closed = preset.closedPackages.includes(pkg);
                return (
                  <Chip
                    key={pkg}
                    on={tiers.includes(pkg)}
                    onClick={() => toggleTier(pkg)}
                    title={
                      closed
                        ? 'Closed for 2026-27. Still selectable, for a family on a pricing hold.'
                        : undefined
                    }
                  >
                    {PACKAGE_LABELS[pkg]}
                    {closed && <span className="ml-1 font-normal opacity-60">closed</span>}
                  </Chip>
                );
              })}
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
      <div
        className={`grid grid-cols-1 gap-3 ${
          preset.offerPackages.length === 2 ? 'sm:grid-cols-2' : 'sm:grid-cols-3'
        }`}
      >
        {preset.offerPackages.map((p) => {
          const P = quote.packages[p];
          const closed = preset.closedPackages.includes(p);
          return (
            <div key={p} className={`neu-raised rounded-[1.5rem] p-4${closed ? ' opacity-60' : ''}`}>
              <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
                {PACKAGE_LABELS[p]}
                {closed && ' · closed 2026-27'}
              </p>
              <p className="mt-1 font-display text-[1.8rem] font-semibold leading-none text-ink">
                {money(P.total)}
              </p>
              {p === 'uvip' && (
                <p className="mt-1 text-[12px] text-ink-faint">all-inclusive · by conversation</p>
              )}
              <p className="mt-1.5 text-[12px] text-ink-soft">
                {money(P.subtotal)} − {money(P.totalDiscount)} ({P.totalDiscountPct}%)
              </p>
              {P.capApplied && (
                <p className="text-[12px] text-terracotta" title="Per-add-on discount is trimmed first; referral and sibling keep their full rate.">
                  capped at {quote.maxStackPct}% (stack was {P.requestedStackPct}%)
                </p>
              )}
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
            {saved && <span className="text-[12px] font-medium text-moss">{savedLabel}</span>}
            <GhostButton onClick={() => save()} disabled={saving}>
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

      {duplicate && (
        <Modal onClose={() => (saving ? null : setDuplicate(null))}>
          <h3 className="font-display text-lg font-semibold text-ink">
            {f.firstName ? `${f.firstName} already has a saved proposal` : 'That student already has a saved proposal'}
          </h3>
          {duplicate.ambiguous ? (
            <>
              {/* More than one proposal carries this name and the builder was
                  not opened from any of them, so there is no way to know which
                  one "update" means. Guessing the newest could overwrite a
                  different family who happens to share a name. */}
              <p className="mt-2 text-[13px] leading-relaxed text-ink-soft">
                There are {duplicate.matches} saved proposals under this name, so I can’t tell which
                one you mean. To edit an existing one, open it from the Saved tab and save from
                there. Otherwise this can be saved as a new proposal.
              </p>
              <div className="mt-5 flex flex-wrap justify-end gap-2">
                <GhostButton onClick={() => setDuplicate(null)} disabled={saving}>
                  Cancel
                </GhostButton>
                <PillButton onClick={() => save({ forceNew: true })} disabled={saving}>
                  {saving ? 'Saving…' : 'Save as a new proposal'}
                </PillButton>
              </div>
            </>
          ) : (
            <>
              <p className="mt-2 text-[13px] leading-relaxed text-ink-soft">
                {duplicate.student_name || 'A proposal'} was saved{' '}
                {duplicate.created_at
                  ? DateTime.fromISO(duplicate.created_at).setZone(ZONE).toFormat('LLL d, yyyy · h:mm a')
                  : 'earlier'}
                {duplicate.created_by ? ` by ${duplicate.created_by}` : ''}. Would you like to update{' '}
                {f.firstName ? `${f.firstName}’s` : 'that'} proposal, or is this a new student?
              </p>
              <div className="mt-5 flex flex-wrap justify-end gap-2">
                <GhostButton onClick={() => setDuplicate(null)} disabled={saving}>
                  Cancel
                </GhostButton>
                <GhostButton onClick={() => save({ forceNew: true })} disabled={saving}>
                  It’s a new student
                </GhostButton>
                <PillButton onClick={() => save({ updateId: duplicate.id })} disabled={saving}>
                  {saving ? 'Updating…' : f.firstName ? `Update ${f.firstName}’s proposal` : 'Update it'}
                </PillButton>
              </div>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}
