'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { DateTime } from 'luxon';
import {
  ChevronLeft,
  ChevronRight,
  Video,
  CalendarDays,
  CalendarPlus,
  CheckCircle2,
  CircleAlert,
  Mail,
  Sparkles,
  Loader2,
} from 'lucide-react';
import { getInstructorPublic } from '@/lib/instructorPublic';

const DAY_NAMES = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const ZONE = 'America/Los_Angeles';
const AGENDA_MAX = 30;

function getToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}
function formatDateStr(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
// "Jun 20–26", or "Jun 27 – Jul 2" across a month boundary (matches the meetings card).
function fmtRange(startISO, endISO) {
  const a = DateTime.fromISO(startISO, { zone: ZONE });
  const b = DateTime.fromISO(endISO, { zone: ZONE });
  if (!a.isValid || !b.isValid) return '';
  return a.month === b.month
    ? `${a.toFormat('LLL d')}–${b.toFormat('d')}`
    : `${a.toFormat('LLL d')} – ${b.toFormat('LLL d')}`;
}
function buildCalendarGrid(year, month) {
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const grid = [];
  let week = [];
  const prevMonthDays = new Date(year, month, 0).getDate();
  for (let i = firstDay - 1; i >= 0; i--) {
    week.push({ date: new Date(year, month - 1, prevMonthDays - i), overflow: true });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    week.push({ date: new Date(year, month, d), overflow: false });
    if (week.length === 7) { grid.push(week); week = []; }
  }
  if (week.length > 0) {
    let nextDay = 1;
    while (week.length < 7) week.push({ date: new Date(year, month + 1, nextDay++), overflow: true });
    grid.push(week);
  }
  return grid;
}
function monthHasBookableSlots(year, month, instructor) {
  const today = DateTime.now().setZone(ZONE).startOf('day');
  const earliest = today.plus({ days: 1 });
  const lastDay = DateTime.fromObject({ year, month: month + 1 }).endOf('month');
  let d = DateTime.fromObject({ year, month: month + 1, day: 1 }, { zone: ZONE });
  while (d <= lastDay) {
    const hours = instructor.hoursByWeekday[d.weekday];
    if (hours && d >= today && d.plus({ hours: hours.start }) >= earliest) return true;
    d = d.plus({ days: 1 });
  }
  return false;
}
function fmtICalDate(d) {
  return new Date(d).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
}
function downloadICal(start, end, title, agenda, zoomLink) {
  const description = agenda ? `Agenda: ${agenda}\\nZoom: ${zoomLink}` : `Zoom: ${zoomLink}`;
  const ical = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Student Portal//Meeting//EN',
    'BEGIN:VEVENT', `UID:${Date.now()}@studentportal`, `DTSTAMP:${fmtICalDate(new Date())}`,
    `DTSTART:${fmtICalDate(start)}`, `DTEND:${fmtICalDate(end)}`,
    `SUMMARY:${title}`, `DESCRIPTION:${description.replace(/\n/g, '\\n')}`,
    `LOCATION:${zoomLink}`, 'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
  const url = URL.createObjectURL(new Blob([ical], { type: 'text/calendar;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'meeting.ics';
  a.click();
  URL.revokeObjectURL(url);
}

export default function BookingFlow({ slug }) {
  const router = useRouter();
  // Which meeting the student picked on /meetings (the type router). Keys:
  // 'oneoff:<id>' for an admin one-off, else the weekly meeting ('cross'/'primary').
  const m = useSearchParams().get('m') || '';
  const instructor = getInstructorPublic(slug);
  const isART = instructor.slug === 'art';
  const bodyName = instructor.bodyName;

  const [validating, setValidating] = useState(true);
  const [authError, setAuthError] = useState(null);
  const [routedKind, setRoutedKind] = useState(null); // 'written' | 'email'
  const [studentName, setStudentName] = useState('');
  const [duration, setDuration] = useState('30min');
  // Seniors: the package's bookable lengths, e.g. ['30min','15min'] (Essential) or
  // ['20min'] (VIP/Comprehensive). null for underclassmen (15/30 token flow).
  const [seniorDurations, setSeniorDurations] = useState(null);
  // Senior calendar context from /api/validateBooking: { kind, eligibleWindow,
  // grantWindow, phase }. null for underclassmen. Drives the context header and
  // the empty-state path; phaseWeek (per month, below) drives the gold coloring.
  const [seniorMeta, setSeniorMeta] = useState(null);
  const durationMins = parseInt(duration, 10) || 30;
  const meetingLabel = `${durationMins}-min Zoom`;

  const today = getToday();
  const [calMonth, setCalMonth] = useState(today.getMonth());
  const [calYear, setCalYear] = useState(today.getFullYear());
  const [availableDates, setAvailableDates] = useState(() => new Set());
  // The viewed month's cross-meeting week {start,end} ISO (seniors only), from
  // getMonthAvailability — present only in the month the cross-meeting belongs to.
  const [phaseWeek, setPhaseWeek] = useState(null);
  const [loadingMonth, setLoadingMonth] = useState(true);
  const [selectedDate, setSelectedDate] = useState(null);
  const [slots, setSlots] = useState([]);
  const [recommended, setRecommended] = useState([]);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [selectedSlot, setSelectedSlot] = useState(null);
  const [agenda, setAgenda] = useState('');

  const [booking, setBooking] = useState(false);
  const [booked, setBooked] = useState(false);
  const [bookedSlot, setBookedSlot] = useState(null);
  const [bookedAgenda, setBookedAgenda] = useState('');
  const [bookingError, setBookingError] = useState(null);

  // 1) validate access + resolve duration
  useEffect(() => {
    let alive = true;
    // Re-navigating from one /meetings card to another swaps `m` without a remount,
    // so clear any prior selection/error before committing to the new meeting.
    setSelectedDate(null);
    setSelectedSlot(null);
    setAuthError(null);
    setRoutedKind(null);
    (async () => {
      try {
        const res = await fetch(`/api/validateBooking?instructor=${instructor.slug}&m=${encodeURIComponent(m)}`);
        const data = await res.json();
        if (!alive) return;
        if (!data.allowed) {
          if (['written', 'email', 'pending'].includes(data.reason)) setRoutedKind(data.reason);
          else setAuthError(data.reason || 'You can’t book a meeting right now.');
          setValidating(false);
          return;
        }
        // Seniors AND project meetings share the windowed, single-/fixed-duration
        // calendar flow (a project meeting is just a standing weekly meeting with its
        // own window). data.project rides the same seniorMeta rendering path.
        if (data.senior || data.project) {
          const ds = (data.durations && data.durations.length ? data.durations : [15]).map((n) => `${n}min`);
          setSeniorDurations(ds);
          setDuration(ds[0]);
          setSeniorMeta({
            kind: data.kind || 'primary', // 'cross' | 'primary' | 'oneoff' | 'project'
            label: data.label || null,
            eligibleWindow: data.eligibleWindow || null,
            grantWindow: data.grantWindow || null,
            phase: data.phase,
            goldWeek: !!data.goldWeek, // only the cross meeting colors its phase week gold
          });
        } else {
          setSeniorDurations(null);
          setSeniorMeta(null);
          setDuration(data.decision === '15min' ? '15min' : '30min');
        }
        setStudentName(data.studentName || '');
        // jump to the first month that actually has bookable weekdays
        if (!monthHasBookableSlots(today.getFullYear(), today.getMonth(), instructor)) {
          const next = new Date(today.getFullYear(), today.getMonth() + 1, 1);
          setCalMonth(next.getMonth());
          setCalYear(next.getFullYear());
        }
        setValidating(false);
      } catch {
        if (!alive) return;
        setAuthError('Something went wrong. Please try again.');
        setValidating(false);
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instructor.slug, m]);

  // 2) month availability
  useEffect(() => {
    if (validating || authError || routedKind) return;
    let cancelled = false;
    setLoadingMonth(true);
    setAvailableDates(new Set());
    setPhaseWeek(null);
    fetch(`/api/getMonthAvailability?month=${calMonth}&year=${calYear}&duration=${durationMins}&instructor=${instructor.slug}&m=${encodeURIComponent(m)}`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        setAvailableDates(new Set(data.availableDates || []));
        setPhaseWeek(data.phaseWeek || null);
        setLoadingMonth(false);
      })
      .catch(() => { if (!cancelled) { setAvailableDates(new Set()); setPhaseWeek(null); setLoadingMonth(false); } });
    return () => { cancelled = true; };
  }, [calMonth, calYear, durationMins, instructor.slug, validating, authError, routedKind]);

  // 3) slots for selected day
  useEffect(() => {
    if (!selectedDate) return;
    setSelectedSlot(null);
    setSlots([]);
    setRecommended([]);
    setLoadingSlots(true);
    fetch(`/api/getAvailableSlots?date=${formatDateStr(selectedDate)}&duration=${durationMins}&instructor=${instructor.slug}&m=${encodeURIComponent(m)}`)
      .then((r) => r.json())
      .then((data) => {
        setSlots(data.slots || []);
        setRecommended(data.recommendations || []);
        setLoadingSlots(false);
      })
      .catch(() => { setSlots([]); setRecommended([]); setLoadingSlots(false); });
  }, [selectedDate, durationMins, instructor.slug]);

  async function handleBook() {
    if (!selectedSlot || !studentName) return;
    setBooking(true);
    setBookingError(null);
    try {
      const res = await fetch('/api/bookMeeting', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          start: selectedSlot.start,
          end: selectedSlot.end,
          duration,
          studentName,
          agenda: agenda.trim(),
          instructor: instructor.slug,
          m, // carries ?m=project:<id> so bookMeeting authorizes/charges the right track
        }),
      });
      const result = await res.json();
      if (!result.success) throw new Error(result.error || 'Booking failed');
      setBookedSlot(selectedSlot);
      setBookedAgenda(agenda.trim());
      setBooked(true);
    } catch (err) {
      setBookingError(err.message);
    } finally {
      setBooking(false);
    }
  }

  function prevMonth() {
    if (calMonth === 0) { setCalMonth(11); setCalYear((y) => y - 1); }
    else setCalMonth((m) => m - 1);
  }
  function nextMonth() {
    if (calMonth === 11) { setCalMonth(0); setCalYear((y) => y + 1); }
    else setCalMonth((m) => m + 1);
  }
  const canGoPrev =
    calYear > today.getFullYear() ||
    (calYear === today.getFullYear() && calMonth > today.getMonth());

  /* ── status screens ───────────────────────────────────────────────────── */

  if (validating) {
    return (
      <div className="portal-rise mx-auto max-w-xl space-y-5">
        <div className="portal-skeleton h-10 w-48 rounded-2xl" />
        <div className="portal-skeleton h-72 rounded-3xl" />
      </div>
    );
  }

  if (routedKind) {
    return (
      <div className="portal-rise flex min-h-[55vh] flex-col items-center justify-center text-center">
        <span className="neu-chip flex h-16 w-16 items-center justify-center rounded-3xl text-terracotta">
          <Mail className="h-8 w-8" strokeWidth={1.7} />
        </span>
        <h1 className="mt-5 font-display text-2xl font-semibold tracking-tight text-ink">
          {routedKind === 'pending' ? 'Under review' : 'No meeting needed'}
        </h1>
        <p className="mt-2 max-w-xs text-sm text-ink-soft">
          {routedKind === 'pending'
            ? 'Your check-in is in — Ryan is deciding whether a meeting is needed. If so, you’ll get an email with a link to book.'
            : routedKind === 'written'
            ? 'Your check-in is in — Ryan will send a written update this week.'
            : 'Your check-in is in — Aaron will follow up over email this week.'}
        </p>
      </div>
    );
  }

  if (authError) {
    return (
      <div className="portal-rise mx-auto mt-8 max-w-md rounded-3xl border border-terracotta/25 bg-clay-50 p-6 text-center">
        <CircleAlert className="mx-auto h-7 w-7 text-terracotta" strokeWidth={2} />
        <p className="mt-3 font-display text-lg font-semibold text-ink">Can’t book right now</p>
        <p className="mt-1 text-sm text-ink-soft">{authError}</p>
      </div>
    );
  }

  if (booked && bookedSlot) {
    const d = new Date(bookedSlot.start);
    const dateLabel = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: ZONE });
    const timeLabel = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: ZONE });
    const eventTitle = bookedAgenda ? `${studentName} – ${duration}: ${bookedAgenda}` : `${studentName} – ${duration}`;
    const gcalDescription = bookedAgenda ? `Agenda: ${bookedAgenda}\nZoom: ${instructor.zoomLink}` : `Zoom: ${instructor.zoomLink}`;
    const gcalUrl = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(eventTitle)}&dates=${fmtICalDate(bookedSlot.start)}/${fmtICalDate(bookedSlot.end)}&details=${encodeURIComponent(gcalDescription)}&location=${encodeURIComponent(instructor.zoomLink)}`;

    return (
      <div className="portal-rise mx-auto max-w-md">
        <div className="flex flex-col items-center text-center">
          <span className="flex h-16 w-16 items-center justify-center rounded-3xl border border-moss/25 bg-moss/[0.08] text-moss shadow-card">
            <CheckCircle2 className="h-8 w-8" strokeWidth={1.9} />
          </span>
          <h1 className="mt-5 font-display text-2xl font-semibold tracking-tight text-ink">Meeting booked</h1>
          <p className="mt-2 text-sm text-ink-soft">
            {dateLabel} · {timeLabel} PT with {bodyName}
          </p>
          {bookedAgenda && <p className="mt-1 text-xs text-ink-faint">Agenda: {bookedAgenda}</p>}
        </div>

        <div className="neu-raised mt-6 rounded-2xl p-4">
          <p className="flex items-center gap-2 text-sm text-ink">
            <Video className="h-4 w-4 text-terracotta" strokeWidth={2} />
            <a href={instructor.zoomLink} target="_blank" rel="noreferrer" className="font-semibold text-terracotta-deep underline">
              {instructor.zoomLink.replace(/^https?:\/\//, '')}
            </a>
          </p>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3">
          <a
            href={gcalUrl}
            target="_blank"
            rel="noreferrer"
            className="neu-chip flex items-center justify-center gap-2 rounded-full px-4 py-3 text-sm font-semibold text-ink transition active:scale-[0.98]"
          >
            <CalendarPlus className="h-4 w-4 text-terracotta" strokeWidth={2} />
            Google
          </a>
          <button
            type="button"
            onClick={() => downloadICal(bookedSlot.start, bookedSlot.end, eventTitle, bookedAgenda, instructor.zoomLink)}
            className="neu-chip flex items-center justify-center gap-2 rounded-full px-4 py-3 text-sm font-semibold text-ink transition active:scale-[0.98]"
          >
            <CalendarPlus className="h-4 w-4 text-terracotta" strokeWidth={2} />
            Apple
          </button>
        </div>

        <button
          type="button"
          onClick={() => router.push('/dashboard')}
          className="mt-6 w-full rounded-full bg-ink px-5 py-3 text-sm font-semibold text-paper transition active:scale-[0.98]"
        >
          Done
        </button>
      </div>
    );
  }

  /* ── booking flow ─────────────────────────────────────────────────────── */

  const grid = buildCalendarGrid(calYear, calMonth);
  const nowLA = DateTime.now().setZone(ZONE);
  // The committed meeting's bookable window (seniors): a day outside it isn't this
  // meeting's, even if the duration-keyed availability happens to include it.
  const elig = seniorMeta?.eligibleWindow || null;
  // Gold phase-week coloring belongs only to the cross meeting.
  const showGold = !!phaseWeek && !!seniorMeta?.goldWeek;

  return (
    <div className="pb-2">
      <header className="mb-6">
        <div className="flex items-center gap-3">
          <span className="neu-chip flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl text-terracotta">
            <Video className="h-5 w-5" strokeWidth={1.9} />
          </span>
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-ink-faint">
              {isART ? 'Advanced Research Team' : `${meetingLabel}`}
            </p>
            <h1 className="font-display text-[1.9rem] font-semibold leading-tight tracking-tight text-ink">
              Book with {bodyName}
            </h1>
            {!seniorMeta && (
              <p className="mt-1 text-sm text-ink-soft">Pick a day, then choose a time.</p>
            )}
          </div>
        </div>
      </header>

      {/* Desktop: calendar on the left, the chosen day's times + agenda + confirm
          on the right. Below lg the two columns simply stack (the mobile flow). */}
      <div className="lg:grid lg:grid-cols-[minmax(0,21rem)_minmax(0,1fr)] lg:items-start lg:gap-7">
        {/* ── LEFT: meeting length (a true sub-choice) + calendar ───────────── */}
        <div>
          {/* Only Essential offers a real length choice (1×30 or 2×15). It filters
              the calendar's open days, so it sits right above the calendar under a
              label — a sub-control, not a page heading. Single-length meetings
              (one-offs, VIP/Comprehensive weekly, the cross) show no pill at all. */}
          {seniorDurations && seniorDurations.length > 1 && (
            <div className="mb-4">
              <p className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-[0.13em] text-ink-faint">
                Meeting length
              </p>
              <div className="neu-inset inline-flex rounded-full p-1">
                {seniorDurations.map((d) => {
                  const mins = parseInt(d, 10);
                  const active = d === duration;
                  return (
                    <button
                      key={d}
                      type="button"
                      onClick={() => {
                        setDuration(d);
                        setSelectedDate(null);
                        setSelectedSlot(null);
                      }}
                      className={`rounded-full px-4 py-1.5 text-sm font-semibold transition ${
                        active ? 'bg-terracotta text-paper shadow-sm' : 'text-ink-soft hover:text-ink'
                      }`}
                    >
                      {mins}-min
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="neu-raised rounded-3xl p-5">
            {/* Senior context lives inside the calendar as a slim note, so the
                cross-meeting language sits right above the week it colors gold. */}
            {seniorMeta && (
              <div
                className={`mb-4 border-b pb-3.5 ${
                  seniorMeta.kind === 'cross' ? 'border-ochre/30' : 'border-sand/60'
                }`}
              >
                <p className="flex items-center gap-2 text-sm font-semibold text-ink">
                  {seniorMeta.kind === 'cross' && (
                    <span className="h-2 w-2 shrink-0 rounded-full bg-ochre" />
                  )}
                  {seniorMeta.kind === 'cross'
                    ? `Monthly cross-meeting with ${bodyName}`
                    : seniorMeta.kind === 'oneoff'
                    ? `One-off meeting with ${bodyName}`
                    : seniorMeta.kind === 'project'
                    ? `${seniorMeta.label || 'Weekly project meeting'} with ${bodyName}`
                    : `Your weekly meeting with ${bodyName}`}
                </p>
                {seniorMeta.eligibleWindow && (
                  <p className="mt-1 text-[13px] leading-relaxed text-ink-soft">
                    {seniorMeta.kind === 'cross' ? 'Book any open day · ' : 'Book '}
                    <span className="font-semibold text-ink">
                      {fmtRange(seniorMeta.eligibleWindow.start, seniorMeta.eligibleWindow.end)}
                    </span>
                  </p>
                )}
              </div>
            )}

            <div className="mb-3 flex items-center justify-between">
              <button
                type="button"
                onClick={prevMonth}
                disabled={!canGoPrev}
                className="flex h-9 w-9 items-center justify-center rounded-full text-ink transition active:scale-90 disabled:opacity-25"
              >
                <ChevronLeft className="h-5 w-5" strokeWidth={2.2} />
              </button>
              <span className="font-display text-base font-semibold text-ink">
                {MONTH_NAMES[calMonth]} {calYear}
              </span>
              <button
                type="button"
                onClick={nextMonth}
                className="flex h-9 w-9 items-center justify-center rounded-full text-ink transition active:scale-90"
              >
                <ChevronRight className="h-5 w-5" strokeWidth={2.2} />
              </button>
            </div>

            <div className="grid grid-cols-7 gap-1">
              {DAY_NAMES.map((d, i) => (
                <div key={i} className="py-1 text-center text-[11px] font-semibold text-ink-faint">
                  {d}
                </div>
              ))}
              {grid.flat().map(({ date, overflow }, i) => {
                const lux = DateTime.fromJSDate(date).setZone(ZONE);
                const isPast = lux.startOf('day') < nowLA.startOf('day');
                const notBookable = !instructor.hoursByWeekday[lux.weekday];
                const tooSoon = lux < nowLA.plus({ days: 1 });
                const dateStr = formatDateStr(date);
                const baseDisabled = isPast || notBookable || tooSoon || overflow;
                const inEligible = !elig || (dateStr >= elig.start && dateStr <= elig.end);
                const isAvailable =
                  !baseDisabled && !loadingMonth && availableDates.has(dateStr) && inEligible;
                const isSelected = selectedDate && dateStr === formatDateStr(selectedDate);
                // Two orthogonal channels: the FILL says whether the day is bookable
                // (terracotta), the gold RING says it's part of the monthly cross-meeting
                // week. A day can be both — bookable AND special. Gold shows only for
                // the cross meeting (showGold), never for a one-off on the same calendar.
                const inPhaseWeek = showGold && dateStr >= phaseWeek.start && dateStr <= phaseWeek.end;
                return (
                  <button
                    key={i}
                    type="button"
                    disabled={!isAvailable}
                    onClick={() => isAvailable && setSelectedDate(date)}
                    className={`flex aspect-square items-center justify-center rounded-xl text-sm transition ${
                      isSelected
                        ? 'bg-terracotta font-bold text-paper shadow-sm'
                        : isAvailable
                        ? 'bg-terracotta/[0.1] font-semibold text-terracotta-deep hover:bg-terracotta/20 active:scale-95'
                        : inPhaseWeek && !overflow
                        ? 'bg-ochre/[0.08] font-medium text-ochre'
                        : overflow
                        ? 'text-ink-faint/40'
                        : 'text-ink-faint/60'
                    }${inPhaseWeek ? ' ring-2 ring-inset ring-ochre/55' : ''}`}
                  >
                    {date.getDate()}
                  </button>
                );
              })}
            </div>
            {loadingMonth && (
              <p className="mt-3 text-center text-xs text-ink-faint">Checking {bodyName}’s availability…</p>
            )}
            {/* Legend appears only when the gold ring is actually on screen — i.e.
                the cross meeting in its phase-week month — and needs a key. */}
            {showGold && !loadingMonth && (
              <div className="mt-4 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 border-t border-sand/60 pt-3.5 text-[11px] font-medium text-ink-soft">
                <span className="flex items-center gap-1.5">
                  <span className="h-3.5 w-3.5 rounded-md bg-terracotta/20" />
                  Open day
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="h-3.5 w-3.5 rounded-md ring-2 ring-inset ring-ochre/60" />
                  Cross-meeting week
                </span>
              </div>
            )}
          </div>

          {/* Seniors: never leave an empty grid as a silent "no". Say where the open
              days actually are and how to get there. */}
          {seniorMeta && !loadingMonth && availableDates.size === 0 && seniorMeta.grantWindow && (
            <p className="mt-3 rounded-2xl bg-clay-50 px-4 py-3 text-center text-[13px] leading-relaxed text-ink-soft">
              No open times with {bodyName} in {MONTH_NAMES[calMonth]}. You can book{' '}
              <span className="font-semibold text-ink">
                {fmtRange(seniorMeta.grantWindow.start, seniorMeta.grantWindow.end)}
              </span>{' '}
              — use the arrows to reach those days.
            </p>
          )}
        </div>

        {/* ── RIGHT: the chosen day's times, then agenda + confirm ──────────── */}
        <div className="mt-6 lg:mt-0">
          {!selectedDate ? (
            // Desktop-only prompt so the right column isn't blank before a pick.
            // On mobile the flow just scrolls calendar → times, so this is hidden.
            <div className="hidden flex-col items-center justify-center rounded-3xl py-16 text-center lg:flex lg:min-h-[20rem]">
              <span className="neu-chip flex h-12 w-12 items-center justify-center rounded-2xl text-terracotta">
                <CalendarDays className="h-5 w-5" strokeWidth={1.9} />
              </span>
              <p className="mt-4 text-sm font-semibold text-ink">Pick a day to see open times</p>
              <p className="mt-1 max-w-[15rem] text-[13px] leading-relaxed text-ink-soft">
                Open days with {bodyName} are highlighted on the calendar.
              </p>
            </div>
          ) : (
            <>
              <p className="text-sm font-semibold text-ink">
                {selectedDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
              </p>
              {!loadingSlots && slots.length > 0 && recommended.length > 0 && (
                <p className="mt-1 flex items-center gap-1.5 text-xs text-ink-soft">
                  <Sparkles className="h-3.5 w-3.5 shrink-0 text-terracotta" strokeWidth={2} />
                  Highlighted times help {bodyName} group meetings together.
                </p>
              )}
              <div className="mt-3">
                {loadingSlots ? (
                  <p className="flex items-center gap-2 text-sm text-ink-faint">
                    <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2.2} />
                    Checking {bodyName}’s calendar…
                  </p>
                ) : slots.length === 0 ? (
                  <p className="text-sm text-ink-soft">No times open this day — try another.</p>
                ) : (
                  <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-4 lg:grid-cols-5">
                    {slots.map((slot, i) => (
                      <SlotChip
                        key={i}
                        slot={slot}
                        chosen={selectedSlot?.start === slot.start}
                        recommended={recommended.some((r) => r.start === slot.start)}
                        onChoose={setSelectedSlot}
                      />
                    ))}
                  </div>
                )}
              </div>

              {/* agenda + confirm */}
              {selectedSlot && (
                <div className="mt-6 space-y-4">
                  <div>
                    <p className="mb-2 text-sm font-semibold text-ink">
                      Agenda <span className="font-normal text-ink-faint">· optional</span>
                    </p>
                    <div className="relative">
                      <input
                        type="text"
                        value={agenda}
                        onChange={(e) => setAgenda(e.target.value.slice(0, AGENDA_MAX))}
                        placeholder="e.g. Course selection for next year"
                        className="neu-inset w-full rounded-2xl px-4 py-3 pr-14 text-[15px] text-ink outline-none transition placeholder:text-ink-faint focus:ring-2 focus:ring-terracotta/25"
                      />
                      <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-xs text-ink-faint">
                        {agenda.length}/{AGENDA_MAX}
                      </span>
                    </div>
                  </div>

                  {bookingError && <p className="text-sm font-medium text-terracotta-deep">{bookingError}</p>}

                  <button
                    type="button"
                    onClick={handleBook}
                    disabled={booking}
                    className="flex w-full items-center justify-center gap-2 rounded-full bg-terracotta px-6 py-3.5 text-sm font-bold text-paper shadow-lift transition active:scale-[0.98] disabled:opacity-60"
                  >
                    {booking ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2.4} />
                        Booking…
                      </>
                    ) : (
                      `Confirm ${meetingLabel}`
                    )}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

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
