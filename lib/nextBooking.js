import { DateTime } from 'luxon';
import { getInstructor } from '@/lib/instructors';
import { computeDayAvailability } from '@/lib/bookingSlots';
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

/* Fourteen days of real, bookable, family-morning slots, grouped by the day the
   FAMILY would call it.

   Days Ryan does not work at all are skipped before any network call: his
   hoursByWeekday is null on Saturday, Sunday and Monday, so a naive sweep would
   spend three of every seven calendar reads proving he is unavailable. Blocks
   are fetched once for the whole sweep rather than once per day. */
export async function nextAvailability({ calendar, lead, days = 14, now = null }) {
  const b = lead.booking || {};
  const instructor = getInstructor(b.instructor || 'ryan');
  const duration = b.durationMinutes || NEXT_DURATION_MINUTES;
  const timezone = b.timezone || 'Asia/Singapore';
  const zoneLabel = b.zoneLabel || 'Singapore time';

  const pacNow = (now || DateTime.now()).setZone('America/Los_Angeles');
  // Same one-day lead time the student booking flow uses, so a family is never
  // offered something the shared availability core would refuse.
  const earliestAllowed = pacNow.plus({ days: 1 });

  const blocks = await listBlocksForBooking();

  const out = [];
  for (let i = 0; i <= days; i++) {
    const day = pacNow.plus({ days: i });
    if (!instructor.hoursByWeekday[day.weekday]) continue;

    const { blocked, slots } = await computeDayAvailability({
      calendar,
      instructor,
      dateStr: day.toISODate(),
      duration,
      earliestAllowed,
      blocks,
    });
    if (blocked) continue;

    const described = slots
      .filter((s) => inFamilyMorning(s, timezone, b.morning))
      .map((s) => describeSlot(s, timezone, zoneLabel));

    for (const s of described) {
      const bucket = out.find((d) => d.date === s.family.date);
      if (bucket) bucket.slots.push(s);
      else
        out.push({
          date: s.family.date,
          dayName: s.family.day,
          label: DateTime.fromISO(s.family.date).toFormat('cccc d LLLL'),
          slots: [s],
        });
    }
  }
  return { timezone, zoneLabel, duration, days: out };
}
