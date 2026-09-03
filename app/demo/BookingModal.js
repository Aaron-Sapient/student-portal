'use client';

import { useMemo, useState } from 'react';
import { CalendarCheck, CheckCircle2, ChevronLeft, Sparkles, Video } from 'lucide-react';

/* The booking flow, on the non-senior path.

   Maya is a senior in the data, but this walks the UNDERCLASSMAN route on
   purpose: it is the one Ryan demonstrates most, and it is the shape of the
   product that a family in a first consultation is being sold. The senior route
   adds a duration toggle, an eligibility window and the gold cross-meeting week
   ring (BookingFlow.js:429-573), all of which need a program the family has not
   bought yet to make any sense.

   What is grafted rather than invented: the slot tile is the product's own
   .neu-slot / .neu-slot-rec pair from app/globals.css:206-232, including the
   sparkle on a recommended time; the calendar cell's four states use the same
   class strings as BookingFlow.js:541-552. Those are the two pieces with real
   craft in them and the two a lookalike gets subtly wrong.

   What is deliberately absent: every fetch. The real flow calls validateBooking,
   getMonthAvailability, getAvailableSlots and bookMeeting. Here availability is
   baked, and confirming books nothing -- it must not be possible for a
   consultation to put a real event on a real calendar. */

function SlotChip({ slot, chosen, recommended, onChoose }) {
  return (
    <button
      type="button"
      onClick={() => onChoose(slot)}
      aria-pressed={chosen}
      className={`relative w-full rounded-2xl px-2 py-2.5 text-center text-sm font-semibold tabular-nums tracking-tight transition ${
        chosen
          ? 'bg-terracotta text-paper shadow-lift'
          : recommended
            ? 'neu-slot neu-slot-rec text-ink'
            : 'neu-slot text-ink'
      }`}
    >
      {recommended && !chosen && (
        <Sparkles
          className="pointer-events-none absolute right-1.5 top-1.5 h-3 w-3 text-terracotta"
          strokeWidth={2.2}
        />
      )}
      {slot.label}
    </button>
  );
}

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

export default function BookingModal({ booking, onDone }) {
  const [instructor, setInstructor] = useState(null);
  const [day, setDay] = useState(null);
  const [slot, setSlot] = useState(null);
  const [agenda, setAgenda] = useState('');
  const [booked, setBooked] = useState(false);

  const inst = booking.instructors.find((i) => i.key === instructor) || null;

  // The month grid: a fixed leading offset then the month's days, so the demo
  // never has to know what today is on the machine it runs on.
  const cells = useMemo(() => {
    const lead = Array.from({ length: booking.month.startWeekday }, () => null);
    const days = Array.from({ length: booking.month.days }, (_, i) => i + 1);
    return [...lead, ...days];
  }, [booking.month]);

  const openDays = inst ? new Set(inst.openDays) : new Set();

  if (booked) {
    return (
      <div className="py-6 text-center">
        <span className="neu-chip mx-auto flex h-16 w-16 items-center justify-center rounded-3xl text-moss">
          <CheckCircle2 className="h-8 w-8" strokeWidth={2} />
        </span>
        <h3 className="mt-5 font-display text-[1.7rem] font-semibold leading-tight text-ink">
          You’re booked
        </h3>
        <p className="mx-auto mt-3 max-w-[38ch] text-[15px] leading-relaxed text-ink-soft">
          {inst.label}, {booking.month.label} {day}, at {slot.label}. A calendar invite goes
          to you and your parents, and it shows up on the Overview as your next meeting.
        </p>
        <button
          type="button"
          onClick={onDone}
          className="mt-7 rounded-full bg-terracotta px-6 py-3 text-[15px] font-semibold text-paper transition active:scale-[0.98]"
        >
          Done
        </button>
      </div>
    );
  }

  /* Step 1: who. The real flow reaches this as a set of OptionCards on the
     meetings page; in a modal it is the first thing rather than a page before. */
  if (!inst) {
    return (
      <div>
        <p className="mb-5 text-[15px] leading-relaxed text-ink-soft">
          Your check-in is in, which is what opens booking. Pick who you need this week.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          {booking.instructors.map((i) => (
            <button
              key={i.key}
              type="button"
              onClick={() => setInstructor(i.key)}
              className="demo-jump neu-raised rounded-3xl p-6 text-left"
            >
              <span className="neu-chip flex h-12 w-12 items-center justify-center rounded-2xl text-terracotta">
                <Video className="h-5 w-5" strokeWidth={1.9} />
              </span>
              <span className="mt-4 block font-display text-[1.3rem] font-semibold leading-snug text-ink">
                {i.label}
              </span>
              <span className="mt-1 block text-[14px] leading-relaxed text-ink-soft">{i.blurb}</span>
              <span className="mt-3 inline-flex items-center gap-2 text-[13px] font-semibold text-terracotta-deep">
                <CalendarCheck className="h-4 w-4" strokeWidth={2.2} aria-hidden />
                {i.duration}
              </span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  /* Step 2: when. Calendar and slots sit side by side, as they do in the
     product at this width. */
  return (
    <div>
      <button
        type="button"
        onClick={() => {
          setInstructor(null);
          setDay(null);
          setSlot(null);
        }}
        className="mb-5 inline-flex items-center gap-1.5 text-[14px] font-semibold text-ink-soft transition hover:text-ink"
      >
        <ChevronLeft className="h-4 w-4" strokeWidth={2.4} aria-hidden />
        {inst.label}, {inst.duration}
      </button>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="neu-raised rounded-3xl p-5">
          <h3 className="font-display text-[1.15rem] font-semibold leading-snug text-ink">
            {booking.month.label}
          </h3>
          <div className="mt-4 grid grid-cols-7 gap-1.5 text-center">
            {WEEKDAYS.map((d, i) => (
              <span key={i} className="pb-1 text-[11px] font-semibold text-ink-faint">
                {d}
              </span>
            ))}
            {cells.map((d, i) => {
              if (d === null) return <span key={`x${i}`} />;
              const isAvailable = openDays.has(d);
              const isSelected = day === d;
              return (
                <button
                  key={d}
                  type="button"
                  disabled={!isAvailable}
                  onClick={() => {
                    setDay(d);
                    setSlot(null);
                  }}
                  className={`flex aspect-square items-center justify-center rounded-xl text-sm transition ${
                    isSelected
                      ? 'bg-terracotta font-bold text-paper shadow-sm'
                      : isAvailable
                        ? 'bg-terracotta/[0.1] font-semibold text-terracotta-deep hover:bg-terracotta/20 active:scale-95'
                        : 'text-ink-faint/60'
                  }`}
                >
                  {d}
                </button>
              );
            })}
          </div>
        </section>

        <section className="neu-raised rounded-3xl p-5">
          <h3 className="font-display text-[1.15rem] font-semibold leading-snug text-ink">
            {day ? `${booking.month.label} ${day}` : 'Pick a day'}
          </h3>
          {!day && (
            <p className="mt-3 text-[14px] leading-relaxed text-ink-soft">
              Days Ryan is open are shaded. Weekends and days already full are not offered.
            </p>
          )}
          {day && (
            <>
              <div className="mt-4 grid grid-cols-3 gap-2">
                {inst.slots.map((s) => (
                  <SlotChip
                    key={s.label}
                    slot={s}
                    chosen={slot?.label === s.label}
                    recommended={s.recommended}
                    onChoose={setSlot}
                  />
                ))}
              </div>
              <label className="mt-5 block">
                <span className="text-[13px] font-semibold text-ink-soft">
                  Agenda, optional
                </span>
                <input
                  type="text"
                  value={agenda}
                  onChange={(e) => setAgenda(e.target.value)}
                  maxLength={30}
                  placeholder="What do you want to cover?"
                  className="neu-inset mt-2 w-full rounded-2xl px-4 py-3 text-[15px] text-ink outline-none transition placeholder:text-ink-faint focus:ring-2 focus:ring-terracotta/25"
                />
              </label>
              <button
                type="button"
                disabled={!slot}
                onClick={() => setBooked(true)}
                className="mt-5 w-full rounded-full bg-terracotta px-6 py-3 text-[15px] font-semibold text-paper transition active:scale-[0.98] disabled:opacity-40"
              >
                {slot ? `Book ${slot.label}` : 'Pick a time'}
              </button>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
