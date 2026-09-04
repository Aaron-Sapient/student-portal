import { DateTime } from 'luxon';
import { getInstructor } from '@/lib/instructors';
import { computeRangeAvailability } from '@/lib/bookingSlots';
import { listBlocksForBooking } from '@/lib/blocks';

/* Shared pieces for the per-lead booking surface (/next/<slug>).
   ─────────────────────────────────────────────────────────────────────────
   The availability itself comes from lib/bookingSlots.js, which is the same
   code app/api/getAvailableSlots serves signed-in students from. Nothing about
   "when is Ryan free" is re-decided here. What lives here is the part that is
   specific to a family reading a page from another hemisphere: which of Ryan's
   real slots fall in THEIR morning, and how to say a time so that neither side
   has to do arithmetic.

   NO HOLDS ARE PLACED ON RYAN'S CALENDAR. Nothing here writes, reserves, or
   pencils anything in: the times offered are computed live from his calendar at
   render, and re-verified live at the moment the family taps confirm. A phantom
   hold is a meeting Ryan cannot see and cannot decline, and a page that
   pre-reserves four slots for one family blocks three of them for everyone
   else, forever, because nothing ever releases them. The cost of the honest
   design is a race: two people can be offered the same slot and the second one
   is told it is gone. That is the correct failure, and it is why the confirm
   step re-checks rather than trusting what the page was rendered with. */

export const NEXT_DURATION_MINUTES = 30;

/* Ryan's standing hours are Tue-Thu 16:00-20:00 and Fri 16:00-19:00 Pacific.
   Singapore is fifteen hours ahead of Pacific daylight time, so 16:00 Pacific
   is 07:00 the next morning there and 20:00 Pacific is 11:00. His entire
   working window already lands inside a Singapore family's morning, which is
   why no special arrangement and no held slot is needed: his ordinary
   availability IS the offer. The window is still applied rather than assumed,
   because it stops being true the moment US clocks change in November (the
   offset becomes sixteen hours) or a lead sits in a different zone. */
export function inFamilyMorning(slot, timezone, morning) {
  const startHour = morning?.startHour ?? 7;
  const endHour = morning?.endHour ?? 11;
  const start = DateTime.fromISO(slot.start).setZone(timezone);
  const end = DateTime.fromISO(slot.end).setZone(timezone);
  if (!start.isValid || !end.isValid) return false;
  const close = start.set({ hour: endHour, minute: 0, second: 0, millisecond: 0 });
  return start.hour >= startHour && end <= close;
}

/* One slot, said twice. The family's clock leads because it is the one they
   read; Pacific follows for the same instant, so a parent forwarding this to a
   student never has to convert anything. Both carry their own DAY, because the
   two are usually different days and a bare time would be actively misleading. */
export function describeSlot(slot, timezone, zoneLabel) {
  const fam = DateTime.fromISO(slot.start).setZone(timezone);
  const pac = DateTime.fromISO(slot.start).setZone('America/Los_Angeles');
  const t = (d) => d.toFormat('h:mm a').toLowerCase();
  return {
    start: slot.start,
    end: slot.end,
    family: { time: t(fam), day: fam.toFormat('cccc'), date: fam.toISODate(), zone: zoneLabel },
    pacific: { time: t(pac), day: pac.toFormat('cccc'), date: pac.toISODate(), zone: 'Irvine' },
    label: `${fam.toFormat('cccc')} ${t(fam)} ${zoneLabel}`,
    subLabel: `${pac.toFormat('cccc')} ${t(pac)} in Irvine`,
  };
}

/* One calendar month of real, bookable, family-morning slots, grouped by the
   day the FAMILY would call it, for a month grid drawn in the family's zone.

   The month is the family's month: `2026-09` means the days a Singapore parent
   calls September, and the grid is the Sunday-to-Saturday block that contains
   them, the same shape the portal's own booking calendar draws. Ryan's calendar
   is read ONCE for the whole grid (lib/bookingSlots computeRangeAvailability)
   and every Pacific day that could land inside the family's grid is scanned:
   a Pacific evening is the family's next morning, so the scan starts one
   Pacific day before the grid does.

   The answer says which dates it covers (`range`), so a day the grid draws is
   either "no times" (inside the range, absent from `days`) or simply not
   computed (outside it), and the client never has to mistake one for the other.

   `month: 'auto'` (the page's own default) means the family's current month,
   or the next one when the current month has nothing left to offer, so a
   family opening the page on the 29th is not shown an empty grid with the
   real times one tap away. */
export async function monthAvailability({ calendar, lead, month = 'auto', now = null }) {
  const b = lead.booking || {};
  const instructor = getInstructor(b.instructor || 'ryan');
  const duration = b.durationMinutes || NEXT_DURATION_MINUTES;
  const timezone = b.timezone || 'Asia/Singapore';
  const zoneLabel = b.zoneLabel || 'Singapore time';

  const pacNow = (now || DateTime.now()).setZone('America/Los_Angeles');
  const famNow = pacNow.setZone(timezone);
  // Same one-day lead time the student booking flow uses, so a family is never
  // offered something the shared availability core would refuse.
  const earliestAllowed = pacNow.plus({ days: 1 });

  const blocks = await listBlocksForBooking();

  async function oneMonth(monthKey) {
    const monthStart = DateTime.fromFormat(monthKey, 'yyyy-LL', { zone: timezone }).startOf('month');
    if (!monthStart.isValid) return null;
    const monthEnd = monthStart.endOf('month');
    // Sunday-start grid. Luxon weekdays run Mon=1..Sun=7, so `weekday % 7` is
    // the number of leading days before the 1st and `6 - (weekday % 7)` the
    // trailing days after the last.
    const gridStart = monthStart.minus({ days: monthStart.weekday % 7 });
    const gridEnd = monthEnd.plus({ days: 6 - (monthEnd.weekday % 7) }).endOf('day');

    // Pacific days that can produce a slot inside this family grid. Nothing
    // before today is worth reading: the lead-time floor refuses it anyway.
    const pacFirst = DateTime.max(
      gridStart.setZone('America/Los_Angeles').minus({ days: 1 }).startOf('day'),
      pacNow.startOf('day')
    );
    const pacLast = gridEnd.setZone('America/Los_Angeles').endOf('day');

    const days = [];
    if (pacLast >= pacFirst) {
      const byDate = await computeRangeAvailability({
        calendar,
        instructor,
        startDateStr: pacFirst.toISODate(),
        endDateStr: pacLast.toISODate(),
        duration,
        earliestAllowed,
        blocks,
      });

      for (const dateStr of Object.keys(byDate).sort()) {
        const { blocked, slots } = byDate[dateStr];
        if (blocked) continue;
        const described = slots
          .filter((s) => inFamilyMorning(s, timezone, b.morning))
          .map((s) => describeSlot(s, timezone, zoneLabel));

        for (const s of described) {
          const famDate = DateTime.fromISO(s.family.date, { zone: timezone });
          if (famDate < gridStart || famDate > gridEnd) continue;
          const bucket = days.find((d) => d.date === s.family.date);
          if (bucket) bucket.slots.push(s);
          else
            days.push({
              date: s.family.date,
              dayName: s.family.day,
              label: famDate.toFormat('cccc d LLLL'),
              slots: [s],
            });
        }
      }
      days.sort((a, c) => (a.date < c.date ? -1 : 1));
    }

    return {
      timezone,
      zoneLabel,
      duration,
      month: monthStart.toFormat('yyyy-LL'),
      monthLabel: monthStart.toFormat('LLLL yyyy'),
      range: { start: gridStart.toISODate(), end: gridEnd.toISODate() },
      today: famNow.toISODate(),
      days,
    };
  }

  if (month !== 'auto') {
    const result = await oneMonth(month);
    return result || { error: 'Bad month' };
  }

  const current = await oneMonth(famNow.toFormat('yyyy-LL'));
  if (current.days.length) return current;
  return oneMonth(famNow.plus({ months: 1 }).toFormat('yyyy-LL'));
}
