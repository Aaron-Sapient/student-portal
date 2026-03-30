'use client';
import { useState, useEffect, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';

const VALID_DAYS = [2, 3, 4];
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

function buildCalendarGrid(year, month) {
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const grid = [];
  let week = Array(firstDay).fill(null);
  for (let d = 1; d <= daysInMonth; d++) {
    week.push(new Date(year, month, d));
    if (week.length === 7) { grid.push(week); week = []; }
  }
  if (week.length > 0) {
    while (week.length < 7) week.push(null);
    grid.push(week);
  }
  return grid;
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
  const [calMonth, setCalMonth] = useState(today.getMonth());
  const [calYear, setCalYear] = useState(today.getFullYear());
  const [selectedDate, setSelectedDate] = useState(null);

  const [slots, setSlots] = useState([]);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [selectedSlot, setSelectedSlot] = useState(null);

  const [agenda, setAgenda] = useState('');

  const [booking, setBooking] = useState(false);
  const [booked, setBooked] = useState(false);
  const [bookedSlot, setBookedSlot] = useState(null);
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
    </div><style>{cssString}</style></div>
  );

  if (booked && bookedSlot) {
    const bookedDate = new Date(bookedSlot.start);
    const dateLabel = bookedDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/Los_Angeles' });
    const timeLabel = bookedDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/Los_Angeles' });
    return (
      <div style={styles.page}><div style={styles.card}>
        <div style={styles.header}>
          <div style={{ ...styles.iconBox, backgroundColor: 'transparent' }}><span style={styles.iconFallback}>🎉</span></div>
          <div><h2 style={styles.title}>Meeting booked!</h2><p style={styles.subtitle}>{dateLabel} at {timeLabel} Pacific</p></div>
        </div>
        <p style={styles.zoomNote}>Zoom: <a href="https://us02web.zoom.us/j/8846768033" style={styles.zoomLink}>us02web.zoom.us/j/8846768033</a></p>
      </div><style>{cssString}</style></div>
    );
  }

  return (
    <>
      <style>{cssString}</style>
      <div style={styles.page}>
        <div style={styles.card}>

          <div style={styles.header}>
            <div style={{ ...styles.iconBox, backgroundColor: 'transparent' }}>
              <span style={styles.iconFallback}>{duration === '15min' ? '📞' : '🎥'}</span>
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
              {grid.flat().map((date, i) => {
                if (!date) return <div key={i} />;
                const dateOnly = new Date(date.getFullYear(), date.getMonth(), date.getDate());
                const isPast = dateOnly < today;
                const notBookable = !VALID_DAYS.includes(date.getDay());
                const tooSoon = date < new Date(Date.now() + 24 * 60 * 60 * 1000);
                const disabled = isPast || notBookable || tooSoon;
                const isSelected = selectedDate && formatDateStr(date) === formatDateStr(selectedDate);
                return (
                  <button key={i} disabled={disabled}
                    onClick={() => !disabled && setSelectedDate(date)}
                    className={disabled ? '' : 'cal-day-hover'}
                    style={{
                      ...styles.calDay,
                      opacity: disabled ? 0.25 : 1,
                      cursor: disabled ? 'default' : 'pointer',
                      backgroundColor: isSelected ? '#C6613F' : 'transparent',
                      color: isSelected ? 'white' : '#111',
                      fontWeight: isSelected ? '700' : '400',
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
                Available times — {selectedDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
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

          {/* Agenda input — appears after slot is chosen */}
          {selectedSlot && (
            <div style={{ marginTop: '1.25rem' }}>
              <div style={styles.slotsDivider} />
              <p style={styles.slotsLabel}>Meeting agenda <span style={{ color: '#aaa', fontWeight: '400' }}>(optional, 30 chars max)</span></p>
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

        </div>
      </div>
    </>
  );
}

export default function BookingPage() {
  return (
    <Suspense fallback={<div style={styles.page}><div style={styles.loadingWrap}><span style={styles.loadingText}>Loading…</span></div></div>}>
      <BookingPageInner />
    </Suspense>
  );
}

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
  calNavBtn: { background: 'none', border: 'none', fontSize: '1.2rem', cursor: 'pointer', color: '#111', padding: '0.25rem 0.5rem', borderRadius: '6px', fontFamily: "'DM Sans', 'Poppins', sans-serif" },
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
    width: '100%',
    padding: '0.75rem 3rem 0.75rem 1rem',
    border: '1px solid white',
    borderRadius: '12px',
    backgroundColor: '#fffef8',
    boxShadow: '0 1px 6px rgba(0,0,0,0.07)',
    fontSize: '0.95rem',
    fontFamily: "'DM Sans', 'Poppins', sans-serif",
    color: '#111',
    outline: 'none',
    boxSizing: 'border-box',
  },
  charCount: {
    position: 'absolute',
    right: '0.85rem',
    top: '50%',
    transform: 'translateY(-50%)',
    fontSize: '0.75rem',
    color: '#aaa',
    fontFamily: "'DM Sans', 'Poppins', sans-serif",
    pointerEvents: 'none',
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
  .cal-day-hover:hover { background-color: #efede2 !important; }
  .slot-btn:hover { opacity: 0.85; }
  .book-btn:hover { opacity: 0.85; }
  .book-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  input::placeholder { color: #bbb; }
  @keyframes pulse { 0%, 100% { opacity: 0.3; } 50% { opacity: 1; } }
`;