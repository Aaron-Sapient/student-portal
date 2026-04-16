'use client';
import { useState, useEffect, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { Video } from 'lucide-react';
import { PhoneCall } from 'lucide-react';
import { DateTime } from 'luxon';

const VALID_DAYS = [2, 3, 4, 5];
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December'
];
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

// Build calendar grid that always shows 6 full weeks,
// including overflow days from prev/next months
function buildCalendarGrid(year, month) {
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const grid = [];
  let week = [];

  // Fill leading days from previous month
  const prevMonthDays = new Date(year, month, 0).getDate();
  for (let i = firstDay - 1; i >= 0; i--) {
    const d = new Date(year, month - 1, prevMonthDays - i);
    week.push({ date: d, overflow: true });
  }

  // Current month days
  for (let d = 1; d <= daysInMonth; d++) {
    week.push({ date: new Date(year, month, d), overflow: false });
    if (week.length === 7) { grid.push(week); week = []; }
  }

  // Fill trailing days from next month
  if (week.length > 0) {
    let nextDay = 1;
    while (week.length < 7) {
      week.push({ date: new Date(year, month + 1, nextDay++), overflow: true });
    }
    grid.push(week);
  }

  return grid;
}

// Check if a given month has any bookable slots (Tue/Wed/Thu, 24hr notice, up to end of month)
function monthHasBookableSlots(year, month, durationMins) {
  // Keep the name 'today', but make it Luxon-powered
  const today = DateTime.now().setZone('America/Los_Angeles').startOf('day');
  const earliest = today.plus({ days: 1 }); // Still named 'earliest'
  const lastDay = DateTime.fromObject({ year, month: month + 1 }).endOf('month');

  // Loop through days of the month
  let d = DateTime.fromObject({ year, month: month + 1, day: 1 }, { zone: 'America/Los_Angeles' });

 while (d <= lastDay) {
  if (VALID_DAYS.includes(d.weekday)) {
    // Determine the start time for that specific day
    const dayStartHour = 16; // Both start at 4pm
    
    // Check if the 4pm slot on this day is at least 24 hours away
    if (d >= today && d.plus({ hours: dayStartHour }) >= earliest) {
      return true;
    }
  }
  d = d.plus({ days: 1 });
}
  return false;
}

// Generate iCal file content
function generateICal(start, end, title, description, location) {
  const fmt = (d) => d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Student Portal//Meeting//EN',
    'BEGIN:VEVENT',
    `UID:${Date.now()}@studentportal`,
    `DTSTAMP:${fmt(new Date())}`,
    `DTSTART:${fmt(new Date(start))}`,
    `DTEND:${fmt(new Date(end))}`,
    `SUMMARY:${title}`,
    `DESCRIPTION:${description.replace(/\n/g, '\\n')}`,
    `LOCATION:${location}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}

function downloadICal(start, end, title, agenda, zoomLink) {
  const description = agenda
    ? `Agenda: ${agenda}\\nZoom: ${zoomLink}`
    : `Zoom: ${zoomLink}`;
  const ical = generateICal(start, end, title, description, zoomLink);
  const blob = new Blob([ical], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'meeting.ics';
  a.click();
  URL.revokeObjectURL(url);
}

function BookingPageInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const typeParam = searchParams.get('type');
  const duration = typeParam === '15' ? '15min' : '30min';
  const durationMins = typeParam === '15' ? 15 : 30;

  const [validating, setValidating] = useState(true);
  const [authError, setAuthError] = useState(null);
  const [studentName, setStudentName] = useState('');

  const today = getToday();

  // Smart month default: if current month has no bookable slots, start on next month
  const defaultMonth = () => {
    const now = new Date();
    if (!monthHasBookableSlots(now.getFullYear(), now.getMonth(), durationMins)) {
      const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      return { month: next.getMonth(), year: next.getFullYear() };
    }
    return { month: now.getMonth(), year: now.getFullYear() };
  };

  const { month: initMonth, year: initYear } = defaultMonth();
  const [calMonth, setCalMonth] = useState(initMonth);
  const [calYear, setCalYear] = useState(initYear);
  const [selectedDate, setSelectedDate] = useState(null);

  const [slots, setSlots] = useState([]);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [selectedSlot, setSelectedSlot] = useState(null);
  const [agenda, setAgenda] = useState('');

  const [booking, setBooking] = useState(false);
  const [booked, setBooked] = useState(false);
  const [bookedSlot, setBookedSlot] = useState(null);
  const [bookedAgenda, setBookedAgenda] = useState('');
  const [bookingError, setBookingError] = useState(null);

  useEffect(() => {
    async function validate() {
      try {
        const res = await fetch('/api/validateBooking');
        const data = await res.json();
        if (!data.allowed) {
          setAuthError(data.reason === 'written'
            ? 'Your check-in has been received. Ryan will send you a written update soon.'
            : data.reason || 'You are not authorized to book a meeting right now.');
          setValidating(false);
          return;
        }
        if (data.decision === '15min' && typeParam !== '15') { router.replace('/booking?type=15'); return; }
        if (data.decision === '30min' && typeParam !== '30') { router.replace('/booking?type=30'); return; }
        setStudentName(data.studentName || '');
        setValidating(false);
      } catch {
        setAuthError('Something went wrong. Please try again.');
        setValidating(false);
      }
    }
    validate();
  }, []);

  useEffect(() => {
    if (!selectedDate) return;
    setSelectedSlot(null);
    setSlots([]);
    setLoadingSlots(true);
    fetch(`/api/getAvailableSlots?date=${formatDateStr(selectedDate)}&duration=${durationMins}`)
      .then(r => r.json())
      .then(data => { setSlots(data.slots || []); setLoadingSlots(false); })
      .catch(() => { setSlots([]); setLoadingSlots(false); });
  }, [selectedDate]);

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
    if (calMonth === 0) { setCalMonth(11); setCalYear(y => y - 1); }
    else setCalMonth(m => m - 1);
  }
  function nextMonth() {
    if (calMonth === 11) { setCalMonth(0); setCalYear(y => y + 1); }
    else setCalMonth(m => m + 1);
  }

  const canGoPrev = calYear > today.getFullYear() ||
    (calYear === today.getFullYear() && calMonth > today.getMonth());
  const grid = buildCalendarGrid(calYear, calMonth);
  const meetingLabel = duration === '15min' ? '15-Minute Call' : '30-Minute Zoom';

  // ── Early render states ───────────────────────────────────────────────────

  if (validating) return (
    <div style={styles.page}><div style={styles.card}>
      <div style={styles.loadingWrap}><div style={styles.loadingDot} /><span style={styles.loadingText}>Checking your booking access…</span></div>
    </div><style>{cssString}</style></div>
  );

  if (authError) return (
    <div style={styles.page}><div style={styles.card}>
      <div style={styles.header}>
        <div style={{ ...styles.iconBox, backgroundColor: 'transparent' }}><span style={styles.iconFallback}>✉️</span></div>
        <div><h2 style={styles.title}>You're all set</h2><p style={styles.subtitle}>{authError}</p></div>
      </div>
      <button onClick={() => router.push('/dashboard')} style={styles.backBtn}>← Back to Dashboard</button>
    </div><style>{cssString}</style></div>
  );

 if (booked && bookedSlot) {
  const bookedDate = new Date(bookedSlot.start);
  const dateLabel = bookedDate.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/Los_Angeles',
  });
  const timeLabel = bookedDate.toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/Los_Angeles',
  });
  const eventTitle = bookedAgenda
    ? `${studentName} – ${duration}: ${bookedAgenda}`
    : `${studentName} – ${duration}`;

  // Google Calendar URL
  const fmt = (d) => new Date(d).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const gcalDescription = bookedAgenda
    ? `Agenda: ${bookedAgenda}\nZoom: https://us02web.zoom.us/j/8846768033`
    : `Zoom: https://us02web.zoom.us/j/8846768033`;
  const gcalUrl = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(eventTitle)}&dates=${fmt(bookedSlot.start)}/${fmt(bookedSlot.end)}&details=${encodeURIComponent(gcalDescription)}&location=${encodeURIComponent('https://us02web.zoom.us/j/8846768033')}`;

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <div style={styles.header}>
          <div style={{ ...styles.iconBox, backgroundColor: 'transparent' }}>
            <span style={styles.iconFallback}>🎉</span>
          </div>
          <div>
            <h2 style={styles.title}>Meeting booked!</h2>
            <p style={styles.subtitle}>{dateLabel} at {timeLabel} Pacific</p>
            {bookedAgenda && (
              <p style={{ ...styles.subtitle, marginTop: '0.2rem', color: '#888' }}>
                Agenda: {bookedAgenda}
              </p>
            )}
          </div>
        </div>

        <p style={styles.zoomNote}>
          Zoom: <a href="https://us02web.zoom.us/j/8846768033" style={styles.zoomLink} target="_blank" rel="noreferrer">
            us02web.zoom.us/j/8846768033
          </a>
        </p>

        {/* Buttons Container */}
        <div style={styles.confirmActions}>
          {/* Google Calendar */}
          <a
            href={gcalUrl}
            target="_blank"
            rel="noreferrer"
            style={styles.calBtn}
            className="cal-btn"
          >
            <span style={styles.calBtnIcon}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M19.5 3h-2.25V1.5h-1.5V3h-7.5V1.5h-1.5V3H4.5A1.5 1.5 0 003 4.5v15A1.5 1.5 0 004.5 21h15a1.5 1.5 0 001.5-1.5v-15A1.5 1.5 0 0019.5 3zm0 16.5h-15V9h15v10.5zm0-12h-15V4.5h2.25V6h1.5V4.5h7.5V6h1.5V4.5h2.25V7.5z" fill="#4285F4"/>
                <path d="M7.5 11.25h1.5v1.5H7.5zm3 0h1.5v1.5H10.5zm3 0h1.5v1.5H13.5zm-6 3h1.5v1.5H7.5zm3 0h1.5v1.5H10.5zm3 0h1.5v1.5H13.5z" fill="#4285F4"/>
              </svg>
            </span>
            Add to Google
          </a>

          {/* Apple Calendar */}
          <button
            onClick={() => downloadICal(
              bookedSlot.start, bookedSlot.end, eventTitle,
              bookedAgenda, 'https://us02web.zoom.us/j/8846768033'
            )}
            style={styles.calBtn}
            className="cal-btn"
          >
            <span style={styles.calBtnIcon}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z" fill="#555"/>
              </svg>
            </span>
            Add to Apple
          </button>
        </div>

        <div style={{ marginTop: '1.25rem' }}>
          <button onClick={() => router.push('/dashboard')} style={styles.backBtn} className="back-btn">
            ← Back to Dashboard
          </button>
        </div>
      </div>
      <style>{cssString}</style>
    </div>
  );
}

  // ── Main booking UI ───────────────────────────────────────────────────────

  return (
    <>
      <style>{cssString}</style>
      <div style={styles.page}>
        <div style={styles.card}>

          <div style={styles.header}>
            <div style={{ ...styles.iconBox, backgroundColor: 'transparent' }}>
              {duration === '15min'
  ? <PhoneCall className="w-13 h-13 text-gray-700 -mt-2" strokeWidth={0.8} />
  : <Video className="w-15 h-15 text-gray-700 -mt-4.5" strokeWidth={0.9} />
}
            </div>
            <div>
              <h2 style={styles.title}>Book a {meetingLabel}</h2>
              <p style={styles.subtitle}>Choose a date, then select an available time.</p>
            </div>
          </div>

          {/* Calendar */}
          <div style={styles.calendarWrap}>
            <div style={styles.calNav}>
              <button onClick={prevMonth} disabled={!canGoPrev}
                style={{ ...styles.calNavBtn, opacity: canGoPrev ? 1 : 0.3 }}>←</button>
              <span style={styles.calMonthLabel}>{MONTH_NAMES[calMonth]} {calYear}</span>
              <button onClick={nextMonth} style={styles.calNavBtn}>→</button>
            </div>

            <div style={styles.calGrid}>
              {DAY_NAMES.map(d => <div key={d} style={styles.calDayHeader}>{d}</div>)}
  {grid.flat().map(({ date, overflow }, i) => {
  // --- NEW LUXON LOGIC START ---
  // This creates a "Luxon" version of the calendar day in Pacific Time
  const luxonDate = DateTime.fromJSDate(date).setZone('America/Los_Angeles');
  const nowInLA = DateTime.now().setZone('America/Los_Angeles');

  // isPast: Is the day before today?
  const isPast = luxonDate.startOf('day') < nowInLA.startOf('day');

  // notBookable: Is it NOT Tue(2), Wed(3), or Thu(4)? 
  // (Luxon uses 1-7 for Mon-Sun, so Tue-Thu is still 2, 3, 4)
  const notBookable = !VALID_DAYS.includes(luxonDate.weekday);

  // tooSoon: Is it less than 24 hours from right now?
  const tooSoon = luxonDate < nowInLA.plus({ days: 1 });

  // --- NEW LUXON LOGIC END ---

  const disabled = isPast || notBookable || tooSoon || overflow;
  const isSelected = selectedDate && formatDateStr(date) === formatDateStr(selectedDate);
  const isAvailable = !disabled;

  return (
    <button key={i} disabled={disabled}
      onClick={() => isAvailable && setSelectedDate(date)}
      className={isAvailable ? 'cal-day-hover' : ''}
      style={{
        ...styles.calDay,
        cursor: isAvailable ? 'pointer' : 'default',
        backgroundColor: isSelected
          ? '#C6613F'
          : isAvailable
            ? 'rgba(198, 97, 63, 0.12)'
            : 'transparent',
        color: isSelected
          ? 'white'
          : isAvailable
            ? '#C6613F'
            : overflow ? '#ccc' : '#bbb',
        fontWeight: isSelected ? '700' : isAvailable ? '600' : '400',
        opacity: 1, // override the old opacity logic entirely
      }}>
      {date.getDate()}
    </button>
  );
})}
            </div>
          </div>

          {/* Slots */}
          {selectedDate && (
            <div style={styles.slotsSection}>
              <div style={styles.slotsDivider} />
              <p style={styles.slotsLabel}>
                Available times — {selectedDate.toLocaleDateString('en-US', {
                  weekday: 'long', month: 'long', day: 'numeric',
                })}
              </p>
              {loadingSlots ? (
                <div style={styles.loadingWrap}><div style={styles.loadingDot} /><span style={styles.loadingText}>Checking Ryan's calendar…</span></div>
              ) : slots.length === 0 ? (
                <p style={styles.noSlots}>No available times on this day. Please choose another.</p>
              ) : (
                <div style={styles.slotsGrid}>
                  {slots.map((slot, i) => {
                    const isChosen = selectedSlot?.start === slot.start;
                    return (
                      <button key={i} onClick={() => setSelectedSlot(slot)} className="slot-btn"
                        style={{
                          ...styles.slotBtn,
                          backgroundColor: isChosen ? '#C6613F' : '#efede2',
                          color: isChosen ? 'white' : '#111',
                          fontWeight: isChosen ? '700' : '500',
                          border: isChosen ? '1px solid #C6613F' : '1px solid #B4B3B0',
                        }}>
                        {slot.label}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Agenda input */}
          {selectedSlot && (
            <div style={{ marginTop: '1.25rem' }}>
              <div style={styles.slotsDivider} />
              <p style={styles.slotsLabel}>
                Meeting agenda <span style={{ color: '#aaa', fontWeight: '400' }}>(optional, 30 chars max)</span>
              </p>
              <div style={{ position: 'relative' }}>
                <input
                  type="text"
                  value={agenda}
                  onChange={e => setAgenda(e.target.value.slice(0, AGENDA_MAX))}
                  placeholder="e.g. Course selection for next year"
                  style={styles.agendaInput}
                />
                <span style={styles.charCount}>{agenda.length}/{AGENDA_MAX}</span>
              </div>
            </div>
          )}

          {/* Book button */}
          {selectedSlot && (
            <div style={{ marginTop: '1.25rem' }}>
              {bookingError && <p style={styles.errorInline}>{bookingError}</p>}
              <button className="book-btn" style={styles.bookBtn} onClick={handleBook} disabled={booking}>
                {booking ? 'Booking…' : `Confirm ${meetingLabel} →`}
              </button>
            </div>
          )}

          {/* Back to dashboard */}
          <div style={{ marginTop: '1.5rem' }}>
            <button onClick={() => router.push('/dashboard')} style={styles.backBtn} className="back-btn">
              ← Back to Dashboard
            </button>
          </div>

        </div>
      </div>
    </>
  );
}

export default function BookingPage() {
  return (
    <Suspense fallback={
      <div style={styles.page}>
        <div style={styles.loadingWrap}><span style={styles.loadingText}>Loading…</span></div>
      </div>
    }>
      <BookingPageInner />
    </Suspense>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = {
  page: { padding: '2rem 1rem', maxWidth: '680px', margin: '0 auto' },
  card: {
    backgroundColor: '#FAF9F4',
    border: '1px solid #B4B3B0',
    borderRadius: '20px',
    padding: '2rem 2.5rem',
    fontFamily: "'DM Sans', 'Poppins', sans-serif",
  },
  header: { display: 'flex', alignItems: 'center', gap: '1.25rem', marginBottom: '2rem' },
  iconBox: { width: '72px', height: '72px', borderRadius: '16px', backgroundColor: '#111', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: '2rem' },
  iconFallback: { fontSize: '2rem', lineHeight: 1 },
  title: { margin: 0, marginLeft: '-4px', fontSize: '2rem', fontWeight: '700', color: '#111', letterSpacing: '-0.02em', fontFamily: "'DM Sans', 'Poppins', sans-serif" },
  subtitle: { margin: '0.2rem 0 0', fontSize: '1rem', color: '#555', fontFamily: "'DM Sans', 'Poppins', sans-serif" },
  calendarWrap: { marginBottom: '0.5rem' },
  calNav: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' },
  calNavBtn: { background: 'none', border: 'none', fontSize: '1.2rem', cursor: 'pointer', color: '#111', padding: '0.25rem 0.5rem', borderRadius: '6px' },
  calMonthLabel: { fontSize: '1rem', fontWeight: '700', color: '#111', fontFamily: "'DM Sans', 'Poppins', sans-serif" },
  calGrid: { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '2px' },
  calDayHeader: { textAlign: 'center', fontSize: '0.75rem', fontWeight: '600', color: '#aaa', padding: '0.25rem 0', fontFamily: "'DM Sans', 'Poppins', sans-serif" },
  calDay: { textAlign: 'center', padding: '0.5rem 0', fontSize: '0.9rem', borderRadius: '8px', border: 'none', fontFamily: "'DM Sans', 'Poppins', sans-serif", transition: 'background-color 0.12s ease' },
  slotsSection: { marginTop: '0.5rem' },
  slotsDivider: { height: '1px', backgroundColor: '#B4B3B0', margin: '1rem 0' },
  slotsLabel: { fontSize: '0.9rem', fontWeight: '600', color: '#555', marginBottom: '0.75rem', fontFamily: "'DM Sans', 'Poppins', sans-serif" },
  slotsGrid: { display: 'flex', flexWrap: 'wrap', gap: '0.5rem' },
  slotBtn: { borderRadius: '10px', padding: '0.45rem 1rem', fontSize: '0.9rem', cursor: 'pointer', fontFamily: "'DM Sans', 'Poppins', sans-serif", transition: 'all 0.12s ease' },
  noSlots: { fontSize: '0.9rem', color: '#aaa', fontFamily: "'DM Sans', 'Poppins', sans-serif" },
  agendaInput: {
    width: '100%', padding: '0.75rem 3rem 0.75rem 1rem',
    border: '1px solid white', borderRadius: '12px', backgroundColor: '#fffef8',
    boxShadow: '0 1px 6px rgba(0,0,0,0.07)', fontSize: '0.95rem',
    fontFamily: "'DM Sans', 'Poppins', sans-serif", color: '#111', outline: 'none', boxSizing: 'border-box',
  },
  charCount: { position: 'absolute', right: '0.85rem', top: '50%', transform: 'translateY(-50%)', fontSize: '0.75rem', color: '#aaa', pointerEvents: 'none' },
confirmActions: {
  display: 'flex',
  gap: '0.75rem',
  marginTop: '1.5rem',
  flexWrap: 'wrap',
},
calBtn: {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.5rem',
  backgroundColor: '#efede2',
  color: '#111',
  border: '1px solid #B4B3B0',
  borderRadius: '999px',
  padding: '0.5rem 1.2rem',
  fontSize: '0.9rem',
  fontWeight: '600',
  cursor: 'pointer',
  fontFamily: "'DM Sans', 'Poppins', sans-serif",
  textDecoration: 'none',
  transition: 'background-color 0.15s ease',
},
calBtnIcon: {
  display: 'flex',
  alignItems: 'center',
},
  backBtn: {
    backgroundColor: '#d8d6c8', color: '#2c2c2c', border: 'none',
    borderRadius: '999px', padding: '0.5rem 1.4rem', fontSize: '0.9rem',
    fontWeight: '600', cursor: 'pointer', fontFamily: "'DM Sans', 'Poppins', sans-serif",
    transition: 'opacity 0.15s ease',
  },
  bookBtn: { display: 'block', width: '100%', padding: '0.85rem', backgroundColor: '#C6613F', color: 'white', border: 'none', borderRadius: '12px', fontSize: '0.95rem', fontWeight: '600', cursor: 'pointer', fontFamily: "'DM Sans', 'Poppins', sans-serif", transition: 'opacity 0.15s ease' },
  zoomNote: { fontSize: '0.9rem', color: '#555', fontFamily: "'DM Sans', 'Poppins', sans-serif", marginTop: '0.5rem' },
  zoomLink: { color: '#C6613F', textDecoration: 'none' },
  loadingWrap: { display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '1rem 0', color: '#888', fontFamily: "'DM Sans', 'Poppins', sans-serif" },
  loadingDot: { width: '8px', height: '8px', borderRadius: '50%', backgroundColor: '#B4B3B0', animation: 'pulse 1.2s ease-in-out infinite', flexShrink: 0 },
  loadingText: { fontSize: '0.9rem' },
  errorInline: { color: '#c0392b', fontSize: '0.85rem', marginBottom: '0.75rem', fontFamily: "'DM Sans', 'Poppins', sans-serif" },
};

const cssString = `
  @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;600;700&display=swap');
  .cal-day-hover:hover { background-color: rgba(198, 97, 63, 0.37) !important; color: #C6613F !important; }
  .slot-btn:hover { opacity: 0.85; }
  .book-btn:hover { opacity: 0.85; }
  .book-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .cal-btn:hover { background-color: #d8d7ce !important; }
  .back-btn:hover { opacity: 0.8; }
  input::placeholder { color: #bbb; }
  @keyframes pulse { 0%, 100% { opacity: 0.3; } 50% { opacity: 1; } }
`;