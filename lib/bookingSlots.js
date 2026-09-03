import { DateTime } from 'luxon';
import { listBlocksForBooking, isDateBlocked, blockedWindowsForDate } from '@/lib/blocks';
import { standingUnavailableWindows, exceedsTeachingRun } from '@/lib/teachingGuardrails';

/* The availability core, extracted 2026-09-03.
   ─────────────────────────────────────────────────────────────────────────
   Both of these lived inline in app/api/getAvailableSlots/route.js. They are
   here because a second caller now needs the SAME answer: the per-lead page
   (/next/<slug>) offers a family real times on Ryan's calendar, and a family
   shown a slot the booking gate would refuse is worse than a family shown
   nothing. Two implementations of "when is Ryan free" would diverge on their
   first divergent day, and the divergence would be invisible until someone
   tapped a time and was told no.

   What did NOT move, deliberately: the senior gate, the project-meeting gate,
   the reschedule-target resolution and the recommendation scoring. Those are
   about a signed-in STUDENT's entitlement, and the lead route has no student,
   no Clerk session and no entitlement ledger. Moving them here would have meant
   a function whose parameters are half-ignored by each caller, which is how a
   shared helper becomes two functions wearing one name. */

/* Every slot for a date, before anything is subtracted. Moved verbatim from the
   route: hours are inclusive of `start` and exclusive of `end`, and a slot is
   only emitted if it ENDS by close, which is what keeps a 45-minute meeting from
   overrunning a 3-hour window. */
export function generateSlots(dateStr, durationMinutes, instructor) {
  const slots = [];
  const zone = 'America/Los_Angeles';
  const dayObj = DateTime.fromISO(dateStr, { zone });
  const hours = instructor.hoursByWeekday[dayObj.weekday];
  if (!hours) return [];

  let startPointer = dayObj.set({ hour: hours.start, minute: 0, second: 0, millisecond: 0 });
  const endLimit = dayObj.set({ hour: hours.end, minute: 0, second: 0, millisecond: 0 });

  while (startPointer < endLimit) {
    const slotEnd = startPointer.plus({ minutes: durationMinutes });
    if (slotEnd <= endLimit) {
      slots.push({
        start: startPointer.toISO(),
        end: slotEnd.toISO(),
        label: startPointer.toLocaleString(DateTime.TIME_SIMPLE),
      });
    }
    startPointer = startPointer.plus({ minutes: durationMinutes });
  }
  return slots;
}

/* One day of real availability: the instructor's hours, minus everything on the
   calendar, minus blocks, minus standing gaps, minus anything that would break
   the teaching-run cap.

   `blocks` is passed in rather than fetched here so a caller sweeping fourteen
   days makes ONE listBlocksForBooking() call instead of fourteen. Pass nothing
   and it fetches its own, which keeps the single-day caller simple. */
export async function computeDayAvailability({
  calendar,
  instructor,
  dateStr,
  duration,
  earliestAllowed,
  replacingEventId = null,
  blocks = null,
}) {
  const zone = 'America/Los_Angeles';
  const requestedDate = DateTime.fromISO(dateStr, { zone });
  const dayStart = requestedDate.startOf('day').toISO();
  const dayEnd = requestedDate.endOf('day').toISO();

  // ART books on Aaron's calendar, so an Aaron block also blocks ART.
  const blockSlugs = instructor.slug === 'art' ? ['art', 'aaron'] : [instructor.slug];

  const [eventsRes, resolvedBlocks] = await Promise.all([
    calendar.events.list({
      calendarId: instructor.calendarId,
      timeMin: dayStart,
      timeMax: dayEnd,
      singleEvents: true,
      orderBy: 'startTime',
    }),
    blocks ? Promise.resolve(blocks) : listBlocksForBooking(),
  ]);

  if (blockSlugs.some((slug) => isDateBlocked(resolvedBlocks, slug, dateStr))) {
    return { blocked: true, slots: [], calendarEvents: [], busyWindows: [] };
  }

  // Every non-cancelled event blocks, including ones Google marks Free. Deliberate —
  // Ryan blocks time off with all-day events, which Google defaults to "Free" and he
  // doesn't re-mark. Do not "fix" this at one site alone.
  const busyWindows = (eventsRes.data.items || [])
    .filter((e) => e.status !== 'cancelled')
    .filter((e) => !replacingEventId || e.id !== replacingEventId)
    .map((e) => ({
      start: DateTime.fromISO(e.start.dateTime || e.start.date),
      end: DateTime.fromISO(e.end.dateTime || e.end.date),
      timed: Boolean(e.start.dateTime),
    }));

  // TIMED events alone feed the teaching-run cap: blocks and standing gaps are time
  // OFF, not teaching, and an all-day event (parsed zoneless) would read as a 24h run
  // bleeding into the neighbouring day. All-day events still block by overlap.
  const calendarEvents = busyWindows.filter((w) => w.timed);

  for (const slug of blockSlugs) {
    busyWindows.push(...blockedWindowsForDate(resolvedBlocks, slug, dateStr));
  }
  busyWindows.push(...standingUnavailableWindows(instructor, dateStr));

  const slots = generateSlots(dateStr, duration, instructor).filter((slot) => {
    const slotStart = DateTime.fromISO(slot.start);
    const slotEnd = DateTime.fromISO(slot.end);
    if (earliestAllowed && slotStart < earliestAllowed) return false;
    if (busyWindows.some((busy) => slotStart < busy.end && slotEnd > busy.start)) return false;
    return !exceedsTeachingRun(instructor, { start: slotStart, end: slotEnd }, calendarEvents);
  });

  return { blocked: false, slots, calendarEvents, busyWindows };
}

/* Is this exact start still free? The question a booking asks at commit time,
   answered by the same function that produced the offer, so the offer and the
   gate cannot disagree. Returns null when bookable, or a reason string. */
export async function verifySlotStillFree({
  calendar,
  instructor,
  startISO,
  duration,
  earliestAllowed,
  replacingEventId = null,
}) {
  const start = DateTime.fromISO(startISO).setZone('America/Los_Angeles');
  if (!start.isValid) return 'That start time is not a valid time.';

  const { blocked, slots } = await computeDayAvailability({
    calendar,
    instructor,
    dateStr: start.toISODate(),
    duration,
    earliestAllowed,
    replacingEventId,
  });
  if (blocked) return 'That day is not available.';

  /* Compared as INSTANTS, not as DateTimes. Luxon's `equals` also requires the
     same zone object, and these two never have one: the offer is built in
     America/Los_Angeles while the start comes back off the wire as an ISO string
     with a numeric offset, which parses to a fixed UTC-7 zone. The two describe
     the same moment and `equals` returns false, so every confirm was refused
     with "that time is no longer available" against a slot the page had just
     offered. Caught 2026-09-03 by dry-running a booking of a slot the slots
     endpoint had listed one second earlier. */
  const match = slots.some((s) => DateTime.fromISO(s.start).toMillis() === start.toMillis());
  return match ? null : 'That time is no longer available.';
}
