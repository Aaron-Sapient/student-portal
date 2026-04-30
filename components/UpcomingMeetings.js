'use client';
import { useState, useEffect } from 'react';
import { Calendar1 } from 'lucide-react';
import { DateTime } from 'luxon';
import { getInstructorPublic } from '@/lib/instructorPublic';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const AGENDA_MAX = 30;

function formatDateStr(date) {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
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

function getMeetingDuration(start, end) {
  const mins = (new Date(end) - new Date(start)) / 60000;
  return mins <= 15 ? '15min' : '30min';
}

function isWithin24Hours(dateStr) {
  return new Date(dateStr) < new Date(Date.now() + 24 * 60 * 60 * 1000);
}

// Parse agenda from event description
// Description format: "Zoom: https://...\nAgenda: some text"
function parseAgenda(description) {
  if (!description) return '';
  // Simply remove any HTML tags like <div> or <br> and return the text
  return description.replace(/<[^>]*>?/gm, '').trim();
}

export default function UpcomingMeetings({ studentName }) {
  const [meetings, setMeetings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [reschedulingId, setReschedulingId] = useState(null);
  const [rescheduleDate, setRescheduleDate] = useState(null);
  const [rescheduleSlots, setRescheduleSlots] = useState([]);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [selectedSlot, setSelectedSlot] = useState(null);
  const [rescheduleAgenda, setRescheduleAgenda] = useState('');
  const [calMonth, setCalMonth] = useState(new Date().getMonth());
  const [calYear, setCalYear] = useState(new Date().getFullYear());
  const [rescheduling, setRescheduling] = useState(false);

  const [cancellingId, setCancellingId] = useState(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelledId, setCancelledId] = useState(null);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  useEffect(() => { fetchMeetings(); }, []);

  useEffect(() => {
    if (!rescheduleDate || !reschedulingId) return;
    setSelectedSlot(null);
    setRescheduleSlots([]);
    setLoadingSlots(true);
    const meeting = meetings.find(m => m.id === reschedulingId);
    const durationMins = meeting ? (getMeetingDuration(meeting.start, meeting.end) === '15min' ? 15 : 30) : 30;
    const instructorSlug = (meeting?.instructor || 'Ryan').toLowerCase();
    fetch(`/api/getAvailableSlots?date=${formatDateStr(rescheduleDate)}&duration=${durationMins}&instructor=${instructorSlug}`)
      .then(r => r.json())
      .then(data => { setRescheduleSlots(data.slots || []); setLoadingSlots(false); })
      .catch(() => { setRescheduleSlots([]); setLoadingSlots(false); });
  }, [rescheduleDate, reschedulingId]);

  async function fetchMeetings() {
    try {
      const res = await fetch('/api/getUpcomingMeetings');
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setMeetings(data.meetings || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleCancel(meeting) {
    setCancelling(true);
    try {
      const res = await fetch('/api/cancelMeeting', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: meeting.id,
          studentName,
          meetingTitle: meeting.title,
          meetingStart: meeting.start,
          duration: getMeetingDuration(meeting.start, meeting.end),
          instructor: (meeting.instructor || 'Ryan').toLowerCase(),
        }),
      });
      const result = await res.json();
      if (!result.success) throw new Error(result.error || 'Cancellation failed');
      setCancelledId(meeting.id);
      setMeetings(prev => prev.filter(m => m.id !== meeting.id));
      setCancellingId(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setCancelling(false);
    }
  }

  async function handleReschedule(meeting) {
    if (!selectedSlot) return;
    setRescheduling(true);
    const instructorSlug = (meeting.instructor || 'Ryan').toLowerCase();
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
      if (!(await cancelRes.json()).success) throw new Error('Failed to cancel old meeting');

      const duration = getMeetingDuration(meeting.start, meeting.end);
      const bookRes = await fetch('/api/bookMeeting', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          start: selectedSlot.start,
          end: selectedSlot.end,
          duration,
          studentName,
          agenda: rescheduleAgenda.trim(),
          isReschedule: true,
          instructor: instructorSlug,
        }),
      });
      if (!(await bookRes.json()).success) throw new Error('Failed to book new meeting');

      await fetchMeetings();
      setReschedulingId(null);
      setRescheduleDate(null);
      setSelectedSlot(null);
      setRescheduleAgenda('');
    } catch (err) {
      setError(err.message);
    } finally {
      setRescheduling(false);
    }
  }

  const canGoPrev = calYear > today.getFullYear() ||
    (calYear === today.getFullYear() && calMonth > today.getMonth());

  return (
    <>
      <style>{cssString}</style>
      <div style={styles.card}>
        <div style={styles.header}>
          <div style={{ ...styles.iconBox, backgroundColor: 'transparent' }}>
            <Calendar1 className="w-15 h-15 text-gray-700 mt-1.5" strokeWidth={0.8} />
          </div>
          <h2 style={styles.title}>Upcoming Meetings</h2>
        </div>

        {loading && (
          <div style={styles.loadingWrap}>
            <div style={styles.loadingDot} />
            <span style={styles.loadingText}>Loading your meetings…</span>
          </div>
        )}

        {error && <p style={styles.errorText}>{error}</p>}

        {!loading && !error && meetings.length === 0 && (
          <p style={styles.emptyText}>
            {cancelledId
              ? 'Your meeting has been cancelled. You can rebook at your convenience through the check-in form below.'
              : 'No upcoming meetings scheduled.'}
          </p>
        )}

        {!loading && meetings.length > 0 && (
          <>
{/* Updated Table Header (Cleaned up for new alignment) */}
<div style={{ ...styles.tableHeader, display: 'flex', alignItems: 'center', width: '100%' }}>
  {/* 1. Fixed width matching the Instructor name */}
  <span style={{ ...styles.colLabel, width: '50px' }}>Staff</span>
  
  {/* 2. Padding to align with the Date Card */}
  <span style={{ ...styles.colLabel, paddingLeft: '1rem' }}>Meeting Details</span>
  
  {/* 3. flex: 1 fills the middle, textAlign: right pushes text to the far edge */}
  <span style={{ ...styles.colLabel, flex: 1, textAlign: 'right' }}>
    Reschedule / Cancel
  </span>
</div>

{meetings.map(meeting => {
  const start = new Date(meeting.start);
  const end = new Date(meeting.end);
  const within24 = isWithin24Hours(meeting.start);
  const isRescheduling = reschedulingId === meeting.id;
  const isCancelling = cancellingId === meeting.id;
  
  // Clean Agenda/Description
  const agendaText = (meeting.description || '').replace(/<[^>]*>?/gm, '').trim();

  const dateLabel = start.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles' });
  const timeRange = `${start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/Los_Angeles' })} – ${end.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/Los_Angeles' })}`;

  return (
  <div key={meeting.id} style={styles.meetingRow}>
    
    {/* ROW 1: Instructor + Date + Vertical Buttons */}
    <div style={styles.topRow}>
      {/* Instructor */}
      <div style={styles.instructorLabel}>
        {meeting.instructor || 'Ryan'}
      </div>

      {/* Date Card with dedicated horizontal space */}
      <div style={styles.dateColumn}>
        <div style={styles.dateCard}>
          <span style={styles.dateMain}>{dateLabel}</span>
          <span style={styles.dateTime}>{timeRange}</span>
        </div>
      </div>

      {/* Action Buttons (Stacked Vertically) */}
      <div style={styles.actionGroup}>
        {within24 ? (
          <span style={styles.lockedNote}>Changes locked</span>
        ) : (
          <>
            <button className="action-btn" style={styles.actionBtn}
              onClick={() => setReschedulingId(isRescheduling ? null : meeting.id)}>
              {isRescheduling ? 'Close ✕' : 'Reschedule'}
            </button>
            <button className="action-btn" style={styles.actionBtn}
              onClick={() => setCancellingId(isCancelling ? null : meeting.id)}>
              Cancel
            </button>
          </>
        )}
      </div>
    </div>

  {/* ROW 2: Agenda Label + Box in same row */}
<div style={styles.agendaRow}>
  {/* Label */}
  <div style={styles.agendaLabel}>
    Agenda
  </div>
  
  {/* Text Box */}
  <div style={styles.agendaCard}>
    {agendaText || <span style={{ color: '#bbb' }}>No agenda provided</span>}
  </div>
</div>


                  {/* Cancel confirm */}
                  {isCancelling && (
                    <div style={styles.inlinePanel}>
                      <p style={styles.inlinePanelText}>
                        Are you sure you want to cancel this meeting? You can rebook at any time through the check-in form below.
                      </p>
                      <div style={{ display: 'flex', gap: '0.75rem' }}>
                        <button className="nav-pill-back" style={styles.navPillBack} onClick={() => setCancellingId(null)}>Keep it</button>
                        <button className="nav-pill-next" style={styles.navPillNext} onClick={() => handleCancel(meeting)} disabled={cancelling}>
                          {cancelling ? 'Cancelling…' : 'Yes, cancel'}
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Inline reschedule */}
                  {isRescheduling && (
                    <div style={styles.inlinePanel}>
                      <p style={styles.inlinePanelText}>Select a new date and time:</p>

                      <div style={styles.calNav}>
                        <button onClick={() => { if(calMonth===0){setCalMonth(11);setCalYear(y=>y-1);}else setCalMonth(m=>m-1); }}
                          disabled={!canGoPrev} style={{ ...styles.calNavBtn, opacity: canGoPrev ? 1 : 0.3 }}>←</button>
                        <span style={styles.calMonthLabel}>{MONTH_NAMES[calMonth]} {calYear}</span>
                        <button onClick={() => { if(calMonth===11){setCalMonth(0);setCalYear(y=>y+1);}else setCalMonth(m=>m+1); }}
                          style={styles.calNavBtn}>→</button>
                      </div>

                      <div style={styles.calGrid}>
                        {DAY_NAMES.map(d => <div key={d} style={styles.calDayHeader}>{d}</div>)}
                        {buildCalendarGrid(calYear, calMonth).flat().map((date, i) => {
                          if (!date) return <div key={i} />;
  // Per-instructor day-of-week filter (Ryan: Tue-Fri, Aaron: Mon-Fri)
  const instructorConfig = getInstructorPublic(meeting.instructor);
  const luxonDate = DateTime.fromJSDate(date).setZone('America/Los_Angeles');
  const nowInLA = DateTime.now().setZone('America/Los_Angeles');

  const isPast = luxonDate.startOf('day') < nowInLA.startOf('day');
  const notBookable = !instructorConfig.hoursByWeekday[luxonDate.weekday];
  const tooSoon = luxonDate < nowInLA.plus({ days: 1 });

  const disabled = isPast || notBookable || tooSoon;

  const isSelected = rescheduleDate && formatDateStr(date) === formatDateStr(rescheduleDate);
  const isAvailable = !disabled;

  return (
    <button
      key={i}
      disabled={disabled}
      onClick={() => isAvailable && setRescheduleDate(date)}
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
            : '#bbb',
        fontWeight: isSelected ? '700' : isAvailable ? '600' : '400',
        opacity: 1,
      }}
    >
      {date.getDate()}
    </button>
  );
})}
                      </div>

                      {rescheduleDate && (
                        <div style={{ marginTop: '1rem' }}>
                          {loadingSlots ? (
                            <div style={styles.loadingWrap}><div style={styles.loadingDot} /><span style={styles.loadingText}>Checking availability…</span></div>
                          ) : rescheduleSlots.length === 0 ? (
                            <p style={styles.emptyText}>No available times on this day.</p>
                          ) : (
                            <div style={styles.slotsGrid}>
                              {rescheduleSlots.map((slot, i) => {
                                const isChosen = selectedSlot?.start === slot.start;
                                return (
                                  <button key={i} onClick={() => setSelectedSlot(slot)} className="slot-btn"
                                    style={{ ...styles.slotBtn,
                                      backgroundColor: isChosen ? '#C6613F' : '#efede2',
                                      color: isChosen ? 'white' : '#111',
                                      fontWeight: isChosen ? '700' : '500',
                                      border: isChosen ? '1px solid #C6613F' : '1px solid #B4B3B0' }}>
                                    {slot.label}
                                  </button>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      )}

                      {/* Agenda input for reschedule */}
                      {selectedSlot && (
                        <div style={{ marginTop: '1rem' }}>
                          <p style={{ ...styles.inlinePanelText, marginBottom: '0.5rem' }}>
                            Update agenda <span style={{ color: '#aaa', fontSize: '0.8rem' }}>(optional, 30 chars max)</span>
                          </p>
                          <div style={{ position: 'relative' }}>
                            <input
                              type="text"
                              value={rescheduleAgenda}
                              onChange={e => setRescheduleAgenda(e.target.value.slice(0, AGENDA_MAX))}
                              placeholder="e.g. Course selection for next year"
                              style={styles.agendaInput}
                            />
                            <span style={styles.charCount}>{rescheduleAgenda.length}/{AGENDA_MAX}</span>
                          </div>
                        </div>
                      )}

                      {selectedSlot && (
                        <div style={{ marginTop: '1rem', display: 'flex', gap: '0.75rem' }}>
                          <button className="nav-pill-back" style={styles.navPillBack}
                            onClick={() => { setReschedulingId(null); setRescheduleDate(null); setSelectedSlot(null); setRescheduleAgenda(''); }}>
                            ← Back
                          </button>
                          <button className="nav-pill-next" style={styles.navPillNext}
                            onClick={() => handleReschedule(meeting)} disabled={rescheduling}>
                            {rescheduling ? 'Rescheduling…' : 'Confirm new time →'}
                          </button>
                        </div>
                      )}
                    </div>
                  )}

                   
                </div>
              );
            })}
          </>
        )}
      </div>
    </>
  );
}

const styles = {
  card: {
    backgroundColor: '#FAF9F4',
    border: '1px solid #B4B3B0',
    borderRadius: '20px',
    padding: '2rem 2.5rem',
    fontFamily: "'DM Sans', 'Poppins', sans-serif",
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '1rem',
    marginBottom: '2rem',
  },
   iconBox: {
    width: '72px',
    height: '72px',
    borderRadius: '16px',
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'center',
    flexShrink: 0,
    fontSize: '2rem',
  },
  iconFallback: { fontSize: '1.75rem', lineHeight: 1 },
  title: {
    margin: 0,
    fontSize: '2rem',
    fontWeight: '700',
    color: '#111',
    letterSpacing: '-0.02em',
    fontFamily: "'DM Sans', 'Poppins', sans-serif",
  },
  tableHeader: {
    display: 'flex',
    paddingBottom: '0.5rem',
    borderBottom: '1px solid #B4B3B0',
    marginBottom: '0.25rem',
  },
  colLabel: {
    fontSize: '0.85rem',
    fontWeight: '600',
    color: '#aaa',
    fontFamily: "'DM Sans', 'Poppins', sans-serif",
  },
meetingRow: {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.75rem',
  padding: '1.25rem 0',
  borderBottom: '1px solid #B4B3B0',
},
topRow: {
  display: 'flex',
  flexDirection: 'row', // Forces horizontal even on mobile
  alignItems: 'center',
  justifyContent: 'flex-start', // Keeps everything tucked to the left
  gap: '0.75rem', // Small, consistent gap between items
  width: '100%',
},
dateColumn: {
  flex: '0 0 180px', 
  display: 'flex',
  justifyContent: 'flex-start',
},
  rowDivider: { height: '1px', backgroundColor: '#B4B3B0' },
dateCard: {
  backgroundColor: '#efede2',
  borderRadius: '12px',
  padding: '0.6rem 0.8rem', // Slightly tighter padding
  display: 'flex',
  flexDirection: 'column',
  gap: '0.1rem',
},
actionGroup: {
  display: 'flex',
  flexDirection: 'column', 
  gap: '0.4rem',
  marginLeft: 'auto', // Keeps the stack on the right
  alignItems: 'flex-end',
},
instructorLabel: {
  fontWeight: '700',
  fontSize: '0.95rem',
  color: '#111',
  minWidth: '50px', // Prevents name from squishing
},
agendaLabel: {
  fontWeight: '700',
  fontSize: '0.8rem',
  color: '#111',
  width: '50px', 
  flexShrink: 0,
  paddingTop: '0', // Removed the top padding to keep it centered
},
agendaRow: {
  display: 'flex',
  flexDirection: 'row',
  gap: '1rem',
  width: '100%',
  alignItems: 'center', // Changed from 'flex-start' to 'center'
},
  dateMain: { fontSize: '0.95rem', fontWeight: '700', color: '#111', fontFamily: "'DM Sans', 'Poppins', sans-serif" },
  dateTime: { fontSize: '0.8rem', color: '#888', fontFamily: "'DM Sans', 'Poppins', sans-serif" },
agendaCard: {
  backgroundColor: '#fffef8',
  border: '1px solid #eee',
  borderRadius: '12px',
  padding: '0.75rem 1rem',
  fontSize: '0.9rem',
  color: '#111',
  boxShadow: '0 1px 6px rgba(0,0,0,0.05)',
  fontFamily: "'DM Sans', 'Poppins', sans-serif",
  flex: 1, // Takes up all remaining space
  wordBreak: 'break-word',
  whiteSpace: 'pre-wrap',
},
actionBtn: {
  backgroundColor: '#efede2',
  border: '1px solid #B4B3B0',
  borderRadius: '10px',
  padding: '0.4rem 0.8rem',
  fontSize: '0.8rem',
  fontWeight: '500',
  cursor: 'pointer',
  fontFamily: "'DM Sans', 'Poppins', sans-serif",
  color: '#111',
  transition: 'background-color 0.12s ease',
  width: '100px', // Uniform width for stacked look
  textAlign: 'center',
},

labelStyle: {
  flex: '0 0 80px', 
  fontWeight: '600', 
  fontSize: '0.9rem', 
  color: '#555',
  fontFamily: "'DM Sans', 'Poppins', sans-serif",
},

  lockedNote: {
    fontSize: '0.75rem', color: '#aaa', textAlign: 'right',
    fontFamily: "'DM Sans', 'Poppins', sans-serif",
    whiteSpace: 'pre-line', lineHeight: 1.4,
  },
  inlinePanel: {
    backgroundColor: '#f5f3ec',
    border: '1px solid #B4B3B0',
    borderRadius: '12px',
    padding: '1.25rem',
    marginBottom: '0.5rem',
  },
  inlinePanelText: {
    fontSize: '0.9rem', color: '#444', marginBottom: '1rem',
    fontFamily: "'DM Sans', 'Poppins', sans-serif",
  },
  agendaInput: {
    width: '100%',
    padding: '0.65rem 3rem 0.65rem 0.85rem',
    border: '1px solid white',
    borderRadius: '10px',
    backgroundColor: '#fffef8',
    boxShadow: '0 1px 6px rgba(0,0,0,0.07)',
    fontSize: '0.9rem',
    fontFamily: "'DM Sans', 'Poppins', sans-serif",
    color: '#111',
    outline: 'none',
    boxSizing: 'border-box',
  },
  charCount: {
    position: 'absolute', right: '0.75rem', top: '50%',
    transform: 'translateY(-50%)', fontSize: '0.7rem', color: '#aaa',
    fontFamily: "'DM Sans', 'Poppins', sans-serif", pointerEvents: 'none',
  },
  navPillBack: {
    backgroundColor: '#d8d6c8', color: '#2c2c2c', border: 'none',
    borderRadius: '999px', padding: '0.5rem 1.4rem', fontSize: '0.9rem',
    fontWeight: '600', cursor: 'pointer', fontFamily: "'DM Sans', 'Poppins', sans-serif",
    transition: 'opacity 0.15s ease',
  },
  navPillNext: {
    backgroundColor: '#C6613F', color: 'white', border: 'none',
    borderRadius: '999px', padding: '0.5rem 1.4rem', fontSize: '0.9rem',
    fontWeight: '600', cursor: 'pointer', fontFamily: "'DM Sans', 'Poppins', sans-serif",
    transition: 'opacity 0.15s ease',
  },
  calNav: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' },
  calNavBtn: { background: 'none', border: 'none', fontSize: '1.1rem', cursor: 'pointer', color: '#111', padding: '0.2rem 0.4rem', borderRadius: '6px' },
  calMonthLabel: { fontSize: '0.9rem', fontWeight: '700', color: '#111', fontFamily: "'DM Sans', 'Poppins', sans-serif" },
  calGrid: { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '2px' },
  calDayHeader: { textAlign: 'center', fontSize: '0.7rem', fontWeight: '600', color: '#aaa', padding: '0.2rem 0', fontFamily: "'DM Sans', 'Poppins', sans-serif" },
  calDay: { textAlign: 'center', padding: '0.4rem 0', fontSize: '0.85rem', borderRadius: '6px', border: 'none', fontFamily: "'DM Sans', 'Poppins', sans-serif", transition: 'background-color 0.12s ease' },
  slotsGrid: { display: 'flex', flexWrap: 'wrap', gap: '0.5rem' },
  slotBtn: { borderRadius: '10px', padding: '0.4rem 0.9rem', fontSize: '0.85rem', cursor: 'pointer', fontFamily: "'DM Sans', 'Poppins', sans-serif", transition: 'all 0.12s ease' },
  loadingWrap: { display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.5rem 0', color: '#888', fontFamily: "'DM Sans', 'Poppins', sans-serif" },
  loadingDot: { width: '8px', height: '8px', borderRadius: '50%', backgroundColor: '#B4B3B0', animation: 'pulse 1.2s ease-in-out infinite', flexShrink: 0 },
  loadingText: { fontSize: '0.9rem' },
  emptyText: { fontSize: '0.9rem', color: '#aaa', fontFamily: "'DM Sans', 'Poppins', sans-serif" },
  errorText: { fontSize: '0.9rem', color: '#c0392b', fontFamily: "'DM Sans', 'Poppins', sans-serif" },
};

const cssString = `
  @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;600;700&display=swap');
.meeting-card-container {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
    padding: 1.5rem 0;
    border-bottom: 1px solid #B4B3B0;
    width: 100%;
  }

  .top-info-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    width: 100%;
    gap: 1rem;
    flex-wrap: wrap; /* Allows stacking on mobile */
  }

  .agenda-section {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    width: 100%;
  }

  @media (max-width: 650px) {
    .top-info-row {
      flex-direction: column;
      align-items: flex-start;
    }
    .action-group {
      width: 100%;
      flex-direction: row !important;
      justify-content: flex-start;
    }
    .table-header-desktop {
      display: none !important;
    }
  }
  .action-btn:hover { background-color: #d8d7ce !important; }
  .cal-day-hover:hover { background-color: rgba(198, 97, 63, 0.37) !important; color: #C6613F !important; }
  .slot-btn:hover { opacity: 0.85; }
  .nav-pill-back:hover { opacity: 0.8; }
  .nav-pill-next:hover { opacity: 0.85; }
  .nav-pill-next:disabled { opacity: 0.5; cursor: not-allowed; }
  input::placeholder { color: #bbb; }
  @keyframes pulse { 0%, 100% { opacity: 0.3; } 50% { opacity: 1; } }
`;