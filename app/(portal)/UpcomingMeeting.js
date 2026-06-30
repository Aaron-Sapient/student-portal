'use client';

import { useEffect, useState } from 'react';
import { DateTime } from 'luxon';
import {
  CalendarClock,
  Video,
  ChevronLeft,
  ChevronRight,
  X,
  Loader2,
  CheckCircle2,
} from 'lucide-react';
import { getInstructorPublic } from '@/lib/instructorPublic';
import { usePortalData } from './PortalDataContext';
import { ZONE } from './portalUtils';

const DAY_NAMES = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const AGENDA_MAX = 30;

function formatDateStr(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function buildCalendarGrid(year, month) {
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const grid = [];
  let week = Array(firstDay).fill(null);
  for (let d = 1; d <= daysInMonth; d++) {
    week.push(new Date(year, month, d));
    if (week.length === 7) { grid.push(week); week = []; }
  }
  if (week.length > 0) { while (week.length < 7) week.push(null); grid.push(week); }
  return grid;
}
// The meeting's ACTUAL length in minutes (from its span) — never a 15/30 bucket.
// Reschedule reuses the same length, so it must be exact: Essential is 15 or 30,
// Comprehensive/VIP are 20, and a one-off can be any admin-set length. Bucketing
// everything >15 to "30min" silently broke reschedule for the 20-min packages
// (30 isn't a valid denomination → canBookOnDate 'bad-duration' → empty calendar).
function meetingMinutes(start, end) {
  return Math.round((new Date(end) - new Date(start)) / 60000);
}
function isWithinHours(dateStr, hours) {
  return new Date(dateStr) < new Date(Date.now() + hours * 60 * 60 * 1000);
}
// Strip HTML, any "Zoom: <url>" boilerplate, bare URLs, and calendar-invite
// decoration ("----( Video Call )---- ---===---") — what's left is the real
// agenda (often nothing, in which case we render no agenda row at all).
export function cleanAgenda(description) {
  const text = (description || '')
    .replace(/<[^>]*>?/gm, ' ')
    .replace(/zoom\s*(link|url|:)?\s*https?:\/\/\S+/gi, ' ')
    .replace(/zoom\s*:\s*\S+/gi, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\(\s*video\s*call\s*\)/gi, ' ')
    .replace(/[-=~_]{3,}/g, ' ')
    .replace(/^\s*agenda\s*:?\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  // decoration-only descriptions reduce to punctuation — treat as no agenda
  return /[\p{L}\p{N}]/u.test(text) ? text : '';
}

// One compact line: "Wed Jun 10 · 11 am – 12:30 pm". Whole hours drop ":00";
// the start meridiem is omitted when it matches the end (e.g. "3:30 – 3:45 pm").
function fmtTime(dt, withMeridiem) {
  const min = dt.minute === 0 ? '' : `:${dt.toFormat('mm')}`;
  const mer = withMeridiem ? ` ${dt.toFormat('a').toLowerCase()}` : '';
  return `${dt.toFormat('h')}${min}${mer}`;
}
export function formatWhen(start, end) {
  const s = DateTime.fromJSDate(start).setZone(ZONE);
  const e = DateTime.fromJSDate(end).setZone(ZONE);
  const sameMeridiem = s.toFormat('a') === e.toFormat('a');
  return `${s.toFormat('ccc LLL d')} · ${fmtTime(s, !sameMeridiem)} – ${fmtTime(e, true)}`;
}

// isNext: only the soonest meeting gets the "Next meeting" eyebrow; the rest
// read "Upcoming" so the list doesn't claim five next meetings at once.
export default function UpcomingMeeting({ meeting: initial, studentName, isNext = true }) {
  const { refreshMeetings } = usePortalData();
  const [meeting, setMeeting] = useState(initial || null);
  const [cancelledNote, setCancelledNote] = useState(false);
  const [mode, setMode] = useState('view'); // view | cancel | reschedule
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // reschedule sub-state
  const now = new Date();
  const [calMonth, setCalMonth] = useState(now.getMonth());
  const [calYear, setCalYear] = useState(now.getFullYear());
  const [rDate, setRDate] = useState(null);
  const [slots, setSlots] = useState([]);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [slot, setSlot] = useState(null);
  const [agenda, setAgenda] = useState('');

  useEffect(() => setMeeting(initial || null), [initial]);

  const inst = meeting ? getInstructorPublic(meeting.instructor) : null;
  const instructorSlug = (meeting?.instructor || 'ryan').toLowerCase();
  // Project meetings can't be rescheduled in place: the rebook would need ?m=project:<id>
  // (else it drops the project track and mis-charges the essay grant), and the
  // still-active booking would block its own week's slots via the 1/week cap. So we route
  // them to cancel+rebook — cancel correctly frees the week, then the Projects card rebooks.
  const isProject = meeting?.bookingType === 'project';

  useEffect(() => {
    if (mode !== 'reschedule' || !rDate || !meeting) return;
    setSlot(null);
    setSlots([]);
    setLoadingSlots(true);
    const mins = meetingMinutes(meeting.start, meeting.end);
    fetch(`/api/getAvailableSlots?date=${formatDateStr(rDate)}&duration=${mins}&instructor=${instructorSlug}`)
      .then((r) => r.json())
      .then((data) => { setSlots(data.slots || []); setLoadingSlots(false); })
      .catch(() => { setSlots([]); setLoadingSlots(false); });
  }, [rDate, mode, meeting, instructorSlug]);

  async function doCancel() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/cancelMeeting', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: meeting.id,
          studentName,
          meetingTitle: meeting.title,
          meetingStart: meeting.start,
          duration: `${meetingMinutes(meeting.start, meeting.end)}min`,
          instructor: instructorSlug,
        }),
      });
      if (!(await res.json()).success) throw new Error('Cancellation failed');
      setMeeting(null);
      setCancelledNote(true);
      setMode('view');
      // Re-sync every surface that lists meetings (Home Today + Meetings subtab).
      refreshMeetings();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function doReschedule() {
    if (!slot) return;
    setBusy(true);
    setError(null);
    try {
      const cancelRes = await fetch('/api/cancelMeeting', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: meeting.id,
          studentName,
          meetingTitle: meeting.title,
          meetingStart: meeting.start,
          isReschedule: true,
          instructor: instructorSlug,
        }),
      });
      if (!(await cancelRes.json()).success) throw new Error('Couldn’t release the old time');

      const bookRes = await fetch('/api/bookMeeting', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          start: slot.start,
          end: slot.end,
          duration: `${meetingMinutes(meeting.start, meeting.end)}min`,
          studentName,
          agenda: agenda.trim(),
          isReschedule: true,
          instructor: instructorSlug,
        }),
      });
      if (!(await bookRes.json()).success) throw new Error('Couldn’t book the new time');

      await refreshMeetings();
      setMode('view');
      setRDate(null);
      setSlot(null);
      setAgenda('');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  /* ── empty / cancelled states ─────────────────────────────────────────── */

  if (!meeting) {
    return (
      <div className="neu-raised rounded-3xl p-5">
        <div className="flex items-center gap-2">
          <CalendarClock className="h-4 w-4 text-terracotta" strokeWidth={2.2} />
          <span className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-soft">
            Next meeting
          </span>
        </div>
        {cancelledNote ? (
          <p className="mt-3 text-sm text-ink-soft">
            Meeting cancelled. You can rebook anytime from{' '}
            <span className="font-semibold text-ink">Book</span>.
          </p>
        ) : (
          <>
            <p className="mt-3 font-display text-lg font-semibold text-ink">No meetings booked</p>
            <p className="mt-1 text-sm text-ink-soft">Book one from the tab below.</p>
          </>
        )}
      </div>
    );
  }

  const start = new Date(meeting.start);
  const end = new Date(meeting.end);
  const within2 = isWithinHours(meeting.start, 2);
  const within24 = isWithinHours(meeting.start, 24);
  const whenStr = formatWhen(start, end);
  const agendaText = cleanAgenda(meeting.description);
  const nowLA = DateTime.now().setZone(ZONE);

  return (
    <div className="neu-raised rounded-3xl p-5">
      {/* Header row: meeting info on the left, a compact vertical action stack on
          the right so the buttons share rows with the info instead of adding any. */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <CalendarClock className="h-4 w-4 text-terracotta" strokeWidth={2.2} />
            <span className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-soft">
              {isNext ? 'Next meeting' : 'Upcoming'}
            </span>
          </div>
          <p className="mt-3 font-display text-lg font-semibold leading-snug text-ink">
            {inst.bodyName}
          </p>
          <p className="mt-0.5 text-sm text-ink-soft">{whenStr}</p>
        </div>

        {mode === 'view' && !within2 && (
          <div className="flex shrink-0 flex-col gap-2">
            {!within24 && !isProject && (
              <button
                type="button"
                onClick={() => setMode('reschedule')}
                className="neu-chip rounded-full px-3.5 py-2 text-sm font-semibold text-ink transition active:scale-[0.97]"
              >
                Reschedule
              </button>
            )}
            <button
              type="button"
              onClick={() => setMode('cancel')}
              className="neu-chip rounded-full px-3.5 py-2 text-sm font-semibold text-ink-soft transition active:scale-[0.97]"
            >
              Cancel
            </button>
          </div>
        )}
      </div>

      {agendaText && (
        <p className="neu-inset mt-3 rounded-2xl px-3.5 py-2.5 text-sm text-ink-soft">
          <span className="font-semibold text-ink">Agenda · </span>{agendaText}
        </p>
      )}

      <a
        href={inst.zoomLink}
        target="_blank"
        rel="noreferrer"
        className="mt-3 inline-flex items-center gap-1.5 text-sm font-semibold text-terracotta-deep underline"
      >
        <Video className="h-4 w-4" strokeWidth={2} />
        Join Zoom
      </a>

      {/* timing notes (the buttons themselves live in the header row above) */}
      {mode === 'view' && within2 && (
        <p className="mt-3 text-xs text-ink-faint">Changes are locked within 2 hours of the meeting.</p>
      )}
      {mode === 'view' && within24 && !within2 && !isProject && (
        <p className="mt-3 text-[11px] text-ink-faint">
          Rescheduling needs 24 hours’ notice — you can still cancel.
        </p>
      )}
      {mode === 'view' && !within2 && isProject && (
        <p className="mt-3 text-[11px] text-ink-faint">
          To move a project meeting, cancel it and rebook the new time from Book.
        </p>
      )}

      {/* cancel confirm */}
      {mode === 'cancel' && (
        <div className="neu-inset mt-4 rounded-2xl p-4">
          <p className="text-sm text-ink-soft">
            Cancel this meeting? You can rebook anytime from Book.
          </p>
          {error && <p className="mt-2 text-sm font-medium text-terracotta-deep">{error}</p>}
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => { setMode('view'); setError(null); }}
              className="neu-chip flex-1 rounded-full px-4 py-2.5 text-sm font-semibold text-ink-soft transition active:scale-[0.98]"
            >
              Keep it
            </button>
            <button
              type="button"
              onClick={doCancel}
              disabled={busy}
              className="flex flex-1 items-center justify-center gap-2 rounded-full bg-terracotta px-4 py-2.5 text-sm font-bold text-paper transition active:scale-[0.98] disabled:opacity-60"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2.4} /> : 'Yes, cancel'}
            </button>
          </div>
        </div>
      )}

      {/* reschedule */}
      {mode === 'reschedule' && (
        <div className="neu-inset mt-4 rounded-2xl p-4">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-sm font-semibold text-ink">Pick a new time</p>
            <button
              type="button"
              onClick={() => { setMode('view'); setRDate(null); setSlot(null); setError(null); }}
              className="flex h-7 w-7 items-center justify-center rounded-full text-ink-faint transition active:scale-90"
            >
              <X className="h-4 w-4" strokeWidth={2.4} />
            </button>
          </div>

          {/* mini calendar */}
          <div className="mb-2 flex items-center justify-between">
            <button
              type="button"
              onClick={() => { if (calMonth === 0) { setCalMonth(11); setCalYear((y) => y - 1); } else setCalMonth((m) => m - 1); }}
              disabled={calYear < now.getFullYear() || (calYear === now.getFullYear() && calMonth <= now.getMonth())}
              className="flex h-8 w-8 items-center justify-center rounded-full text-ink transition active:scale-90 disabled:opacity-25"
            >
              <ChevronLeft className="h-4 w-4" strokeWidth={2.2} />
            </button>
            <span className="font-display text-sm font-semibold text-ink">{MONTH_NAMES[calMonth]} {calYear}</span>
            <button
              type="button"
              onClick={() => { if (calMonth === 11) { setCalMonth(0); setCalYear((y) => y + 1); } else setCalMonth((m) => m + 1); }}
              className="flex h-8 w-8 items-center justify-center rounded-full text-ink transition active:scale-90"
            >
              <ChevronRight className="h-4 w-4" strokeWidth={2.2} />
            </button>
          </div>
          <div className="grid grid-cols-7 gap-1">
            {DAY_NAMES.map((d, i) => (
              <div key={i} className="py-1 text-center text-[10px] font-semibold text-ink-faint">{d}</div>
            ))}
            {buildCalendarGrid(calYear, calMonth).flat().map((date, i) => {
              if (!date) return <div key={i} />;
              const lux = DateTime.fromJSDate(date).setZone(ZONE);
              const isPast = lux.startOf('day') < nowLA.startOf('day');
              const notBookable = !inst.hoursByWeekday[lux.weekday];
              const tooSoon = lux < nowLA.plus({ days: 1 });
              const isAvailable = !(isPast || notBookable || tooSoon);
              const isSel = rDate && formatDateStr(date) === formatDateStr(rDate);
              return (
                <button
                  key={i}
                  type="button"
                  disabled={!isAvailable}
                  onClick={() => isAvailable && setRDate(date)}
                  className={`flex aspect-square items-center justify-center rounded-lg text-sm transition ${
                    isSel
                      ? 'bg-terracotta font-bold text-paper'
                      : isAvailable
                      ? 'bg-terracotta/[0.1] font-semibold text-terracotta-deep active:scale-95'
                      : 'text-ink-faint/50'
                  }`}
                >
                  {date.getDate()}
                </button>
              );
            })}
          </div>

          {rDate && (
            <div className="mt-3">
              {loadingSlots ? (
                <p className="flex items-center gap-2 text-sm text-ink-faint">
                  <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2.2} />
                  Checking availability…
                </p>
              ) : slots.length === 0 ? (
                <p className="text-sm text-ink-soft">
                  No times open this day. Try another day, or cancel and rebook from{' '}
                  <span className="font-semibold text-ink">Book</span>.
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {slots.map((s, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => setSlot(s)}
                      className={`rounded-xl px-3.5 py-2 text-sm font-semibold transition active:scale-95 ${
                        slot?.start === s.start
                          ? 'bg-terracotta text-paper'
                          : 'neu-chip text-ink'
                      }`}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {slot && (
            <div className="mt-3">
              <div className="relative">
                <input
                  type="text"
                  value={agenda}
                  onChange={(e) => setAgenda(e.target.value.slice(0, AGENDA_MAX))}
                  placeholder="Update agenda (optional)"
                  className="neu-inset w-full rounded-2xl px-4 py-2.5 pr-12 text-sm text-ink outline-none placeholder:text-ink-faint focus:ring-2 focus:ring-terracotta/25"
                />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-ink-faint">
                  {agenda.length}/{AGENDA_MAX}
                </span>
              </div>
              {error && <p className="mt-2 text-sm font-medium text-terracotta-deep">{error}</p>}
              <button
                type="button"
                onClick={doReschedule}
                disabled={busy}
                className="mt-3 flex w-full items-center justify-center gap-2 rounded-full bg-terracotta px-4 py-3 text-sm font-bold text-paper shadow-lift transition active:scale-[0.98] disabled:opacity-60"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2.4} /> : 'Confirm new time'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
