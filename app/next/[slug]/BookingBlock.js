'use client';

import { useMemo, useState } from 'react';
import { DateTime } from 'luxon';
import { ChevronLeft, ChevronRight } from 'lucide-react';

/* The booking control. The ONLY client component on this route.
   ─────────────────────────────────────────────────────────────────────────
   A month grid in the FAMILY's own calendar, the way the portal's booking
   calendar and every scheduling product a parent has used draw it: the days
   with open mornings are the ones that look like buttons, everything else is a
   number. Tap a day and its times appear under the grid, on both clocks. Tap a
   time and the confirm appears. Two taps to choose, one to book.

   The first month arrives already computed from the server, with the first
   open day pre-selected, so the first paint carries real times before any
   JavaScript runs; what JavaScript adds is the ability to change them. Paging
   to another month is one fetch of /api/next/slots?month=, cached per month
   for the life of the page.

   NOTHING IS HELD while they decide. The times shown were free when the page
   was rendered and are checked again server-side at confirm; if someone else
   took the slot in between, the answer comes back as a plain sentence and the
   month refreshes. That race is the honest cost of not pencilling a family into
   Ryan's calendar before they have agreed to anything. */

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/* How far ahead the arrows go. Each month is one live calendar read, and a
   family booking a second conversation is choosing between next week and the
   one after, not next season. */
const MONTHS_AHEAD = 3;

function monthKeyOf(iso) {
  return iso.slice(0, 7);
}

function addMonths(monthKey, n) {
  return DateTime.fromFormat(monthKey, 'yyyy-LL', { zone: 'utc' }).plus({ months: n }).toFormat('yyyy-LL');
}

/* The 35 or 42 cells of one month's grid, from the range the server computed
   (Sunday on or before the 1st through Saturday on or after the last). Dates
   are compared as ISO strings throughout, in the family's zone, which is the
   only zone this grid knows about. */
function cellsOf(month) {
  if (!month?.range) return [];
  const out = [];
  let d = DateTime.fromISO(month.range.start, { zone: 'utc' });
  const end = DateTime.fromISO(month.range.end, { zone: 'utc' });
  while (d <= end) {
    out.push({ iso: d.toISODate(), day: d.day, inMonth: d.toFormat('yyyy-LL') === month.month });
    d = d.plus({ days: 1 });
  }
  return out;
}

function firstOpenDay(month) {
  const inMonth = (month?.days || []).find((d) => monthKeyOf(d.date) === month.month);
  return inMonth?.date || null;
}

/* One time, as a chip. The day belongs to the heading above the list, so the
   chip carries only what distinguishes it from its neighbours: one line, the
   family's own time and its zone code, "7:00 am SGT".

   Ryan's clock used to ride along underneath. It went on 2026-09-04 (Aaron):
   eight chips repeating one fifteen-hour offset is noise, not information, and
   the family is not choosing between the two clocks, only between the times.
   Both survive where the choice is actually made, on the confirm sentence, and
   in the aria-label here, which costs a sighted reader nothing. */
function Slot({ slot, selected, onSelect }) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(slot)}
        aria-pressed={selected}
        aria-label={`${slot.family.day} ${slot.family.time} ${slot.family.zone}, ${slot.pacific.day} ${slot.pacific.time} in Irvine`}
        className={`min-h-[52px] w-full rounded-[1.25rem] px-4 py-3 text-center ${
          selected ? 'slot-on' : 'neu-slot'
        }`}
      >
        <span className="font-display text-[1.1rem] font-semibold leading-tight">
          {slot.family.time}
        </span>
        {slot.family.abbr && <span className="slot-abbr">{slot.family.abbr}</span>}
      </button>
    </li>
  );
}

export default function BookingBlock({ slug, initial, copy }) {
  const [months, setMonths] = useState(() =>
    initial?.month?.month ? { [initial.month.month]: initial.month } : {}
  );
  const [monthKey, setMonthKey] = useState(initial?.month?.month || null);
  const [selectedDate, setSelectedDate] = useState(() => firstOpenDay(initial?.month));
  const [selected, setSelected] = useState(null);
  const [booked, setBooked] = useState(initial?.booked || null);
  const [busy, setBusy] = useState(false);
  const [loadingMonth, setLoadingMonth] = useState(false);
  const [error, setError] = useState(null);

  const month = monthKey ? months[monthKey] : null;
  const today = month?.today || initial?.month?.today || null;
  const cells = useMemo(() => cellsOf(month), [month]);
  const openDates = useMemo(() => new Set((month?.days || []).map((d) => d.date)), [month]);
  const dayData = selectedDate ? (month?.days || []).find((d) => d.date === selectedDate) : null;

  const firstKey = today ? monthKeyOf(today) : monthKey;
  const canPrev = Boolean(monthKey && firstKey && monthKey > firstKey);
  const canNext = Boolean(monthKey && firstKey && monthKey < addMonths(firstKey, MONTHS_AHEAD));

  async function loadMonth(key, { force = false } = {}) {
    if (!force && months[key]) return months[key];
    setLoadingMonth(true);
    try {
      const res = await fetch(
        `/api/next/slots?slug=${encodeURIComponent(slug)}&month=${encodeURIComponent(key)}`,
        { cache: 'no-store' }
      );
      if (!res.ok) throw new Error('bad month');
      const data = await res.json();
      setMonths((m) => ({ ...m, [data.month]: data }));
      return data;
    } catch {
      setError('That month could not be loaded. Please try again.');
      return null;
    } finally {
      setLoadingMonth(false);
    }
  }

  async function go(delta) {
    if (!monthKey) return;
    const key = addMonths(monthKey, delta);
    setError(null);
    setSelected(null);
    const data = await loadMonth(key);
    if (!data) return;
    setMonthKey(key);
    setSelectedDate(firstOpenDay(data));
  }

  function pickDay(iso) {
    if (!openDates.has(iso)) return;
    setSelectedDate(iso);
    setSelected(null);
    setError(null);
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
        /* Almost always because someone else took it. Re-ask the server for
           this month rather than leaving a grid we now know is stale. */
        if (monthKey) await loadMonth(monthKey, { force: true });
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

  if (!month) {
    return <p className="mt-6 text-[16px] leading-relaxed text-ink-soft">{copy.emptyLabel}</p>;
  }

  const monthLabel = month.monthLabel || DateTime.fromFormat(month.month, 'yyyy-LL').toFormat('LLLL yyyy');

  return (
    <div className="book-grid mt-6">
      {/* ── The month ──────────────────────────────────────────────────── */}
      <div className="cal" aria-busy={loadingMonth}>
        <div className="cal-head">
          <button
            type="button"
            className="cal-nav"
            onClick={() => go(-1)}
            disabled={!canPrev || loadingMonth}
            aria-label="Previous month"
          >
            <ChevronLeft size={22} strokeWidth={2} aria-hidden="true" />
          </button>
          <p className="cal-title" aria-live="polite">
            {monthLabel}
          </p>
          <button
            type="button"
            className="cal-nav"
            onClick={() => go(1)}
            disabled={!canNext || loadingMonth}
            aria-label="Next month"
          >
            <ChevronRight size={22} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>

        {/* Plain buttons, not an ARIA grid: a grid role promises row/cell
            keyboard navigation this control does not implement, and a
            pressed button says "this is the chosen day" in every reader. */}
        <div className="cal-grid" aria-label={monthLabel}>
          {WEEKDAYS.map((w) => (
            <span key={w} className="cal-wd" aria-hidden="true">
              {w}
            </span>
          ))}
          {cells.map((c) => {
            const open = c.inMonth && openDates.has(c.iso);
            const isToday = c.iso === today;
            const isSelected = c.iso === selectedDate;
            const state = isSelected ? 'selected' : open ? 'open' : c.inMonth ? 'closed' : 'overflow';
            return (
              <button
                key={c.iso}
                type="button"
                className={`cal-day cal-day-${state}${isToday ? ' cal-day-today' : ''}`}
                disabled={!open}
                aria-pressed={isSelected}
                aria-label={DateTime.fromISO(c.iso, { zone: 'utc' }).toFormat('cccc d LLLL')}
                onClick={() => pickDay(c.iso)}
              >
                {c.day}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── The chosen day, and everything that follows from choosing one ──
          On a phone this is the next thing down the stack, which is the order
          a thumb reads. From 1024px it is the second COLUMN, beside the month
          rather than under it, and that is not the phone layout scaled up: the
          day you tapped and the times it produced are in one field of view, so
          the grid visibly answers the tap, and the confirm sits under the chip
          that raised it instead of a calendar's height below it. */}
      <div className="book-times">
        {dayData ? (
          <>
            <div className="book-times-head">
              <p className="eyebrow">{dayData.label}</p>
            </div>
            <ul className="book-slots">
              {dayData.slots.map((slot) => (
                <Slot
                  key={slot.start}
                  slot={slot}
                  selected={selected?.start === slot.start}
                  onSelect={setSelected}
                />
              ))}
            </ul>
          </>
        ) : (
          <div className="book-times-head">
            <p className="text-[15px] leading-relaxed text-ink-soft">
              {month.days.length
                ? 'Tap a day to see its times.'
                : `No mornings are open in ${monthLabel}. Try the next month.`}
            </p>
          </div>
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
    </div>
  );
}
