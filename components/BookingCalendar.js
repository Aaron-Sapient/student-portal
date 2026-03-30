'use client'
import { useState, useEffect } from 'react'

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']

export default function BookingCalendar({ activeProjects = [] }) {
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const [viewYear, setViewYear] = useState(today.getFullYear())
  const [viewMonth, setViewMonth] = useState(today.getMonth())
  const [selectedDate, setSelectedDate] = useState(null)
  const [availableSlots, setAvailableSlots] = useState([])
  const [loadingSlots, setLoadingSlots] = useState(false)
  const [availableDates, setAvailableDates] = useState({}) // { "2026-03-15": true/false }
  const [loadingMonth, setLoadingMonth] = useState(false)

  const [selectedSlot, setSelectedSlot] = useState(null)
  const [purpose, setPurpose] = useState('')
  const [projectName, setProjectName] = useState('')
  const [booking, setBooking] = useState(false)
  const [bookingResult, setBookingResult] = useState(null)

  // Get all weekdays in the current view month
  function getWeekdaysInMonth(year, month) {
    const days = []
    const d = new Date(year, month, 1)
    while (d.getMonth() === month) {
      const day = d.getDay()
      if (day !== 0 && day !== 6) {
        const iso = d.toISOString().split('T')[0]
        // Only future dates (not today or past)
        if (d > today) days.push(iso)
      }
      d.setDate(d.getDate() + 1)
    }
    return days
  }

  // Fetch availability for all weekdays in month
  useEffect(() => {
    setAvailableDates({})
    setSelectedDate(null)
    setAvailableSlots([])
    setSelectedSlot(null)
    setBookingResult(null)

    const weekdays = getWeekdaysInMonth(viewYear, viewMonth)
    if (weekdays.length === 0) return

    setLoadingMonth(true)

    // Fetch all days in parallel
    Promise.all(
      weekdays.map(date =>
        fetch(`/api/available-slots?date=${date}`)
          .then(r => r.json())
          .then(data => ({ date, hasSlots: (data.slots || []).length > 0 }))
          .catch(() => ({ date, hasSlots: false }))
      )
    ).then(results => {
      const map = {}
      results.forEach(({ date, hasSlots }) => { map[date] = hasSlots })
      setAvailableDates(map)
      setLoadingMonth(false)
    })
  }, [viewYear, viewMonth])

  // Fetch slots when a date is selected
  function handleSelectDate(dateStr) {
    if (selectedDate === dateStr) {
      setSelectedDate(null)
      setAvailableSlots([])
      setSelectedSlot(null)
      return
    }
    setSelectedDate(dateStr)
    setSelectedSlot(null)
    setBookingResult(null)
    setLoadingSlots(true)
    fetch(`/api/available-slots?date=${dateStr}`)
      .then(r => r.json())
      .then(data => {
        setAvailableSlots(data.slots || [])
        setLoadingSlots(false)
      })
  }

  async function handleBook() {
    if (!selectedDate || !selectedSlot || !purpose) return
    setBooking(true)
    setBookingResult(null)
    try {
      const res = await fetch('/api/book-meeting', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: selectedDate,
          slot: selectedSlot,
          purpose,
          projectName,
          tutorId: 'aaron',
        }),
      })
      const data = await res.json()
      if (data.success) {
        setBookingResult({ type: 'success', message: 'Meeting booked! Check your email for confirmation.' })
        setSelectedSlot(null)
        setPurpose('')
        setProjectName('')
        // Refresh availability
        setAvailableDates(prev => ({ ...prev, [selectedDate]: false }))
      } else {
        setBookingResult({ type: 'error', message: data.error || 'Something went wrong.' })
      }
    } catch {
      setBookingResult({ type: 'error', message: 'Network error. Please try again.' })
    }
    setBooking(false)
  }

  // Build calendar grid
  function buildCalendarGrid() {
    const firstDay = new Date(viewYear, viewMonth, 1).getDay()
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate()
    const cells = []
    for (let i = 0; i < firstDay; i++) cells.push(null)
    for (let d = 1; d <= daysInMonth; d++) cells.push(d)
    return cells
  }

  const cells = buildCalendarGrid()

  function formatSlot(slot) {
    const [h, m] = slot.split(':').map(Number)
    const period = h >= 12 ? 'PM' : 'AM'
    const hour = h > 12 ? h - 12 : h
    return `${hour}:${m === 0 ? '00' : m} ${period}`
  }

  function formatDate(dateStr) {
    if (!dateStr) return ''
    const [y, mo, d] = dateStr.split('-').map(Number)
    return `${MONTHS[mo - 1]} ${d}, ${y}`
  }

  const prevMonth = () => {
    if (viewMonth === 0) { setViewMonth(11); setViewYear(y => y - 1) }
    else setViewMonth(m => m - 1)
  }
  const nextMonth = () => {
    if (viewMonth === 11) { setViewMonth(0); setViewYear(y => y + 1) }
    else setViewMonth(m => m + 1)
  }

  // Don't allow navigating to past months
  const isPrevDisabled = viewYear === today.getFullYear() && viewMonth === today.getMonth()

  return (
    <div style={{
      display: 'flex',
      gap: '0',
      background: '#fff',
      borderRadius: '16px',
      border: '1px solid #e5e7eb',
      overflow: 'hidden',
      boxShadow: '0 4px 24px rgba(0,0,0,0.07)',
      minHeight: '420px',
    }}>
      {/* Left: Calendar */}
      <div style={{ flex: '0 0 360px', padding: '28px', borderRight: selectedDate ? '1px solid #e5e7eb' : 'none' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px' }}>
          <button
            onClick={prevMonth}
            disabled={isPrevDisabled}
            style={{
              background: 'none', border: '1px solid #e5e7eb', borderRadius: '8px',
              width: '32px', height: '32px', cursor: isPrevDisabled ? 'not-allowed' : 'pointer',
              opacity: isPrevDisabled ? 0.3 : 1, fontSize: '16px', display: 'flex',
              alignItems: 'center', justifyContent: 'center',
            }}
          >‹</button>
          <span style={{ fontWeight: '700', fontSize: '16px', color: '#111' }}>
            {MONTHS[viewMonth]} {viewYear}
          </span>
          <button
            onClick={nextMonth}
            style={{
              background: 'none', border: '1px solid #e5e7eb', borderRadius: '8px',
              width: '32px', height: '32px', cursor: 'pointer', fontSize: '16px',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >›</button>
        </div>

        {/* Day headers */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', marginBottom: '8px' }}>
          {DAYS.map(d => (
            <div key={d} style={{ textAlign: 'center', fontSize: '11px', fontWeight: '600',
              color: '#9ca3af', padding: '4px 0', letterSpacing: '0.05em' }}>
              {d}
            </div>
          ))}
        </div>

        {/* Calendar grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '2px' }}>
          {cells.map((day, i) => {
            if (!day) return <div key={`empty-${i}`} />
            const dateStr = `${viewYear}-${String(viewMonth + 1).padStart(2,'0')}-${String(day).padStart(2,'0')}`
            const isToday = dateStr === today.toISOString().split('T')[0]
            const isPast = new Date(dateStr) <= today
            const isWeekend = [0, 6].includes(new Date(dateStr).getDay())
            const hasSlots = availableDates[dateStr] === true
            const isSelected = selectedDate === dateStr
            const isUnavailable = isPast || isWeekend

            return (
              <button
                key={dateStr}
                onClick={() => !isUnavailable && handleSelectDate(dateStr)}
                disabled={isUnavailable || loadingMonth}
                style={{
                  width: '100%', aspectRatio: '1', borderRadius: '50%', border: 'none',
                  background: isSelected ? '#111' : hasSlots ? '#f0fdf4' : 'transparent',
                  color: isSelected ? '#fff' : isUnavailable ? '#d1d5db' : hasSlots ? '#16a34a' : '#374151',
                  fontWeight: isSelected ? '700' : hasSlots ? '600' : '400',
                  cursor: isUnavailable ? 'default' : 'pointer',
                  fontSize: '13px',
                  position: 'relative',
                  transition: 'all 0.15s ease',
                  outline: isToday && !isSelected ? '2px solid #e5e7eb' : 'none',
                }}
              >
                {day}
                {hasSlots && !isSelected && (
                  <span style={{
                    position: 'absolute', bottom: '3px', left: '50%',
                    transform: 'translateX(-50%)',
                    width: '4px', height: '4px', borderRadius: '50%',
                    background: '#16a34a', display: 'block',
                  }} />
                )}
              </button>
            )
          })}
        </div>

        {loadingMonth && (
          <p style={{ textAlign: 'center', color: '#9ca3af', fontSize: '12px', marginTop: '16px' }}>
            Checking availability...
          </p>
        )}

        <div style={{ marginTop: '20px', display: 'flex', gap: '16px', fontSize: '11px', color: '#9ca3af' }}>
          <span>🟢 Available</span>
          <span style={{ color: '#d1d5db' }}>○ Unavailable</span>
        </div>
      </div>

      {/* Right: Slot picker — slides in */}
      {selectedDate && (
        <div style={{
          flex: 1, padding: '28px', background: '#fafafa',
          animation: 'slideIn 0.2s ease',
        }}>
          <style>{`
            @keyframes slideIn {
              from { opacity: 0; transform: translateX(16px); }
              to { opacity: 1; transform: translateX(0); }
            }
          `}</style>

          <h3 style={{ fontSize: '15px', fontWeight: '700', color: '#111', marginBottom: '4px' }}>
            {formatDate(selectedDate)}
          </h3>
          <p style={{ fontSize: '12px', color: '#9ca3af', marginBottom: '20px' }}>
            All times in Pacific Time · 30 min sessions
          </p>

          {loadingSlots ? (
            <p style={{ color: '#9ca3af', fontSize: '13px' }}>Loading slots...</p>
          ) : availableSlots.length === 0 ? (
            <p style={{ color: '#9ca3af', fontSize: '13px' }}>No available slots on this day.</p>
          ) : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '24px' }}>
                {availableSlots.map(slot => (
                  <button
                    key={slot}
                    onClick={() => { setSelectedSlot(slot); setBookingResult(null) }}
                    style={{
                      padding: '10px', borderRadius: '8px', fontSize: '13px', fontWeight: '600',
                      border: selectedSlot === slot ? '2px solid #111' : '1px solid #e5e7eb',
                      background: selectedSlot === slot ? '#111' : '#fff',
                      color: selectedSlot === slot ? '#fff' : '#374151',
                      cursor: 'pointer', transition: 'all 0.15s ease',
                    }}
                  >
                    {formatSlot(slot)}
                  </button>
                ))}
              </div>

              {/* Booking form */}
              {selectedSlot && (
                <div style={{ animation: 'slideIn 0.2s ease' }}>
                  <div style={{ marginBottom: '12px' }}>
                    <label style={{ fontSize: '12px', fontWeight: '600', color: '#374151', display: 'block', marginBottom: '6px' }}>
                      Project / Topic *
                    </label>
                    <select
                      value={projectName}
                      onChange={e => setProjectName(e.target.value)}
                      style={{
                        width: '100%', padding: '8px 10px', borderRadius: '8px',
                        border: '1px solid #e5e7eb', fontSize: '13px', background: '#fff',
                        color: '#374151', marginBottom: '8px',
                      }}
                    >
                      <option value=''>Select a project...</option>
                      {activeProjects.map((p, i) => (
                        <option key={i} value={p.name}>{p.name}</option>
                      ))}
                      <option value='__other__'>Other / Type my own</option>
                    </select>
                    {projectName === '__other__' && (
                      <input
                        type='text'
                        placeholder='Describe the topic...'
                        value={purpose}
                        onChange={e => setPurpose(e.target.value)}
                        style={{
                          width: '100%', padding: '8px 10px', borderRadius: '8px',
                          border: '1px solid #e5e7eb', fontSize: '13px',
                          boxSizing: 'border-box',
                        }}
                      />
                    )}
                  </div>

                  <div style={{ marginBottom: '16px' }}>
                    <label style={{ fontSize: '12px', fontWeight: '600', color: '#374151', display: 'block', marginBottom: '6px' }}>
                      Purpose / Agenda *
                    </label>
                    <textarea
                      placeholder='What do you want to cover in this meeting?'
                      value={projectName !== '__other__' ? purpose : undefined}
                      onChange={e => setPurpose(e.target.value)}
                      rows={3}
                      style={{
                        width: '100%', padding: '8px 10px', borderRadius: '8px',
                        border: '1px solid #e5e7eb', fontSize: '13px', resize: 'vertical',
                        boxSizing: 'border-box', fontFamily: 'inherit',
                      }}
                    />
                  </div>

                  {bookingResult && (
                    <div style={{
                      padding: '10px 14px', borderRadius: '8px', marginBottom: '12px',
                      background: bookingResult.type === 'success' ? '#f0fdf4' : '#fef2f2',
                      color: bookingResult.type === 'success' ? '#16a34a' : '#dc2626',
                      fontSize: '13px', fontWeight: '500',
                    }}>
                      {bookingResult.message}
                    </div>
                  )}

                  <button
                    onClick={handleBook}
                    disabled={booking || !purpose || (!projectName || projectName === '__other__' && !purpose)}
                    style={{
                      width: '100%', padding: '12px', borderRadius: '8px',
                      background: '#111', color: '#fff', border: 'none',
                      fontSize: '14px', fontWeight: '700', cursor: booking ? 'wait' : 'pointer',
                      opacity: booking ? 0.7 : 1, transition: 'opacity 0.15s',
                    }}
                  >
                    {booking ? 'Booking...' : `Confirm ${formatSlot(selectedSlot)}`}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
