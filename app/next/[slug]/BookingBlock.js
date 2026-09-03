'use client';

import { useState } from 'react';

/* The booking control. The ONLY client component on this route.
   ─────────────────────────────────────────────────────────────────────────
   It is handed the first days of real availability as a prop, already computed
   on the server, so the block renders with real times in the HTML before any
   JavaScript runs. A family on a slow phone in Singapore sees Ryan's actual
   Saturday mornings in the first paint; what JavaScript adds is the ability to
   tap one.

   Two taps, deliberately. Select, then confirm. A one-tap-books control on a
   phone books the wrong time roughly as often as a thumb is imprecise, and the
   cost of that error lands on a family who then has to work out how to undo it.
   The second tap is also where the live re-check happens, so the confirm is the
   moment the offer is tested rather than trusted.

   NOTHING IS HELD while they decide. The times shown were free when the page
   was rendered and are checked again server-side at confirm; if someone else
   took the slot in between, the answer comes back as a plain sentence and the
   list refreshes. That race is the honest cost of not pencilling a family into
   Ryan's calendar before they have agreed to anything. */

/* One time, as a chip rather than a full-width card.

   Ryan's hours produce up to eight slots a day across eight days, and a card
   each was fifty full-width tiles on a phone: a scroll wall, and every label
   wrapped to two lines because it repeated the day the heading above it had
   just said. The day belongs to the GROUP, so the chip carries only what
   distinguishes it from its neighbours: the family's time, large, with the same
   instant on Ryan's clock underneath.

   Both clocks stay on every chip. The offset is fifteen hours and the two are
   usually different days, so a time without its counterpart is the exact
   ambiguity this page exists to remove. The aria-label spells the whole thing
   out, because a screen reader gets no help from the visual grouping. */
function Slot({ slot, selected, onSelect }) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(slot)}
        aria-pressed={selected}
        aria-label={`${slot.family.day} ${slot.family.time} ${slot.family.zone}, ${slot.pacific.day} ${slot.pacific.time} in Irvine`}
        className={`min-h-[64px] w-full rounded-[1.25rem] px-4 py-3 text-left ${
          selected ? 'neu-inset' : 'neu-slot'
        }`}
      >
        <span className="block font-display text-[1.1rem] font-semibold leading-tight text-ink">
          {slot.family.time}
        </span>
        <span className="mt-0.5 block text-[13px] leading-tight text-ink-soft">
          {slot.pacific.day.slice(0, 3)} {slot.pacific.time} Irvine
        </span>
      </button>
    </li>
  );
}

export default function BookingBlock({ slug, initial, copy }) {
  const [days, setDays] = useState(initial?.days || []);
  const [selected, setSelected] = useState(null);
  const [booked, setBooked] = useState(initial?.booked || null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [showAll, setShowAll] = useState(false);

  /* Three days by default. Rendered on the server too, so the first paint is
     the same three a family sees after hydration and nothing reflows under
     their thumb. */
  const shown = showAll ? days : days.slice(0, 3);

  async function refresh() {
    try {
      const res = await fetch(`/api/next/slots?slug=${encodeURIComponent(slug)}`, {
        cache: 'no-store',
      });
      if (res.ok) setDays((await res.json()).days || []);
    } catch {
      /* Leave the list as it was. A failed refresh must not blank the only
         control on the page. */
    }
  }

  async function confirm() {
    if (!selected || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/next/book', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, start: selected.start }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error || 'That time could not be booked.');
        setSelected(null);
        /* Almost always because someone else took it. Re-ask the server rather
           than leaving a list we now know is stale on screen. */
        await refresh();
        return;
      }
      setBooked(json.booked);
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  if (booked) {
    return (
      <div className="neu-raised mt-6 rounded-[1.75rem] p-7">
        <p className="font-display text-[1.5rem] font-semibold leading-tight text-ink">
          {copy.booked.heading}
        </p>
        <p className="mt-3 font-display text-[1.15rem] font-semibold leading-snug text-ink">
          {booked.slot.family.day} {booked.slot.family.time} {booked.slot.family.zone}
        </p>
        <p className="mt-0.5 text-[14px] leading-snug text-ink-soft">
          {booked.slot.pacific.day} {booked.slot.pacific.time} in Irvine
        </p>
        <p className="mt-4 text-[16px] leading-relaxed text-ink-soft">
          {booked.email
            ? `An invitation is on its way to ${booked.email} with the Zoom link. ${copy.booked.body}`
            : `An invitation is on its way with the Zoom link. ${copy.booked.body}`}
        </p>
      </div>
    );
  }

  if (!days.length) {
    return <p className="mt-6 text-[16px] leading-relaxed text-ink-soft">{copy.emptyLabel}</p>;
  }

  return (
    <div className="mt-6">
      {shown.map((day) => (
        <div key={day.date} className="mt-7 first:mt-0">
          {/* The day heading is smaller and quieter than the times under it: it
              groups them, it is not one of them. It also carries the day and
              date so no chip has to repeat them. Same rule the portal's college
              list follows. */}
          <p className="eyebrow">{day.label}</p>
          <ul className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {day.slots.map((slot) => (
              <Slot
                key={slot.start}
                slot={slot}
                selected={selected?.start === slot.start}
                onSelect={setSelected}
              />
            ))}
          </ul>
        </div>
      ))}

      {/* Eight days at once is a wall. The first three carry the soonest times,
          which is what almost every family picks from; the rest are one tap
          away for the one who is travelling that week. Not a paywall and not a
          nudge, just the difference between a page you scan and a page you
          scroll past. */}
      {days.length > shown.length && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="neu-chip mt-7 min-h-[48px] w-full rounded-full px-6 text-[15px] font-semibold text-terracotta-deep"
        >
          Show more times
        </button>
      )}

      {error && (
        <p role="status" className="mt-6 text-[15px] leading-relaxed text-terracotta-deep">
          {error}
        </p>
      )}

      {/* The confirm appears only once a time is chosen. An always-present
          disabled button is a control that spends the page's loudest slot
          saying "not yet". */}
      {selected && (
        <div className="mt-7">
          <button
            type="button"
            onClick={confirm}
            disabled={busy}
            className="sticky-book-btn w-full disabled:opacity-70"
          >
            {busy ? 'Booking…' : copy.confirmLabel}
          </button>
          <p className="mt-3 text-[14px] leading-relaxed text-ink-faint">
            {selected.family.day} {selected.family.time} {selected.family.zone}, which is{' '}
            {selected.pacific.day} {selected.pacific.time} in Irvine.
          </p>
        </div>
      )}
    </div>
  );
}
