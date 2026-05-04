'use client';
import { useEffect, useState, useMemo } from 'react';
import { DateTime } from 'luxon';

const CARD = {
  backgroundColor: '#FAF9F4',
  border: '1px solid #E5E3DD',
  borderRadius: '12px',
  padding: '1.25rem 1.5rem',
  marginBottom: '1.5rem',
  fontFamily: "'DM Sans', 'Poppins', sans-serif",
};

const H2 = {
  fontSize: '22px',
  fontWeight: 700,
  marginBottom: '0.75rem',
  color: '#111',
  fontFamily: "'DM Sans', 'Poppins', sans-serif",
};

const BTN_DARK = {
  backgroundColor: '#111',
  color: '#fff',
  padding: '8px 16px',
  borderRadius: '999px',
  border: 'none',
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: "'DM Sans', sans-serif",
  fontSize: '13px',
};

const BTN_GHOST = {
  ...BTN_DARK,
  backgroundColor: 'transparent',
  color: '#111',
  border: '1px solid #111',
};

const INPUT = {
  padding: '6px 10px',
  border: '1px solid #B4B3B0',
  borderRadius: '6px',
  fontFamily: 'inherit',
  fontSize: '13px',
};

function formatPacific(iso) {
  if (!iso) return '—';
  const dt = DateTime.fromISO(iso).setZone('America/Los_Angeles');
  if (!dt.isValid) return '—';
  return dt.toFormat("ccc LLL d, h:mma");
}

function formatDateOnly(iso) {
  if (!iso) return '—';
  const dt = DateTime.fromISO(iso).setZone('America/Los_Angeles');
  if (!dt.isValid) return '—';
  return dt.toFormat('LLL d, yyyy');
}

// Build a value compatible with <input type="datetime-local"> from an ISO string.
function toLocalInputValue(iso) {
  if (!iso) return '';
  const dt = DateTime.fromISO(iso).setZone('America/Los_Angeles');
  return dt.isValid ? dt.toFormat("yyyy-LL-dd'T'HH:mm") : '';
}

function UsageWheel({ data }) {
  const enabled = data?.enabled;
  const month = data?.month ?? 0;
  // No formal budget — render the ring proportional to a soft $50/month reference,
  // capped at 100%, just to give a visual sense of scale.
  const REF = 50;
  const pct = Math.min(1, month / REF);
  const radius = 38;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - pct);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
      <svg width="100" height="100" viewBox="0 0 100 100">
        <circle cx="50" cy="50" r={radius} stroke="#E5E3DD" strokeWidth="8" fill="none" />
        {enabled && (
          <circle
            cx="50" cy="50" r={radius}
            stroke="#C6613F" strokeWidth="8" fill="none"
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
            strokeLinecap="round"
            transform="rotate(-90 50 50)"
          />
        )}
        <text x="50" y="48" textAnchor="middle" fontSize="14" fontWeight="700" fill="#111" fontFamily="DM Sans">
          {enabled ? `$${month.toFixed(2)}` : '—'}
        </text>
        <text x="50" y="62" textAnchor="middle" fontSize="9" fill="#666" fontFamily="DM Sans">
          this month
        </text>
      </svg>
      <div style={{ fontSize: '13px', color: '#3c3c3c' }}>
        {enabled ? (
          <>
            <div><strong>Today:</strong> ${data.today.toFixed(2)}</div>
            <div><strong>Month:</strong> ${data.month.toFixed(2)}</div>
            <div style={{ fontSize: '11px', color: '#888', marginTop: 4 }}>Ring scaled to $50/mo reference</div>
          </>
        ) : (
          <div style={{ maxWidth: 260 }}>
            <div style={{ fontWeight: 600 }}>Anthropic usage disabled</div>
            <div style={{ fontSize: '12px', color: '#666', marginTop: 4 }}>
              Add <code>ANTHROPIC_ADMIN_KEY</code> to <code>.env.local</code> and restart the dev server.
              {data?.reason && <div style={{ marginTop: 4, fontStyle: 'italic' }}>{data.reason}</div>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function BlocksSection({ blocks, onAdd, onDelete }) {
  const [instructor, setInstructor] = useState('aaron');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!startDate) return;
    setSubmitting(true);
    await onAdd({ instructor, startDate, endDate: endDate || startDate, reason });
    setStartDate('');
    setEndDate('');
    setReason('');
    setSubmitting(false);
  };

  return (
    <section style={CARD}>
      <h2 style={H2}>Block off dates</h2>
      <form onSubmit={submit} style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center', marginBottom: '1rem' }}>
        <select value={instructor} onChange={e => setInstructor(e.target.value)} style={INPUT}>
          <option value="aaron">Aaron</option>
          <option value="ryan">Ryan</option>
        </select>
        <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} required style={INPUT} />
        <span style={{ fontSize: '13px', color: '#666' }}>to</span>
        <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} style={INPUT} placeholder="(same)" />
        <input type="text" value={reason} onChange={e => setReason(e.target.value)} placeholder="Reason (optional)" style={{ ...INPUT, flex: 1, minWidth: 180 }} />
        <button type="submit" disabled={submitting} style={BTN_DARK}>
          {submitting ? 'Adding…' : 'Add block'}
        </button>
      </form>

      {blocks.length === 0 ? (
        <p style={{ fontSize: '13px', color: '#666' }}>No blocks set.</p>
      ) : (
        <table style={{ width: '100%', fontSize: '13px', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '1px solid #E5E3DD' }}>
              <th style={{ padding: '6px 4px' }}>Instructor</th>
              <th style={{ padding: '6px 4px' }}>Range</th>
              <th style={{ padding: '6px 4px' }}>Reason</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {blocks.map(b => (
              <tr key={b.rowIndex} style={{ borderBottom: '1px solid #F0EEE8' }}>
                <td style={{ padding: '8px 4px', textTransform: 'capitalize' }}>{b.instructor}</td>
                <td style={{ padding: '8px 4px' }}>
                  {b.startDate}{b.endDate && b.endDate !== b.startDate ? ` → ${b.endDate}` : ''}
                </td>
                <td style={{ padding: '8px 4px', color: '#666' }}>{b.reason || '—'}</td>
                <td style={{ padding: '8px 4px', textAlign: 'right' }}>
                  <button onClick={() => onDelete(b.rowIndex)} style={{ ...BTN_GHOST, padding: '4px 12px', fontSize: '12px' }}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function MeetingsSection({ meetings, refresh }) {
  const [busyId, setBusyId] = useState(null);
  const [reschedTarget, setReschedTarget] = useState(null);
  const [reschedValue, setReschedValue] = useState('');

  const cancelMeeting = async (m) => {
    if (!confirm(`Cancel ${m.studentName || m.title} (${m.instructor}) on ${formatPacific(m.start)}? Student will be emailed and their token refunded.`)) return;
    setBusyId(m.id);
    try {
      const res = await fetch('/api/developer/cancelMeeting', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: m.id,
          instructor: m.instructorSlug,
          studentEmail: m.studentEmail,
          studentName: m.studentName,
          meetingStart: m.start,
          duration: m.duration,
        }),
      });
      const data = await res.json();
      if (!res.ok) alert('Cancel failed: ' + (data.error || 'unknown'));
      await refresh();
    } finally {
      setBusyId(null);
    }
  };

  const openReschedule = (m) => {
    setReschedTarget(m);
    setReschedValue(toLocalInputValue(m.start));
  };

  const submitReschedule = async () => {
    if (!reschedTarget || !reschedValue) return;
    const newStartDt = DateTime.fromISO(reschedValue, { zone: 'America/Los_Angeles' });
    const oldStartDt = DateTime.fromISO(reschedTarget.start);
    const oldEndDt = DateTime.fromISO(reschedTarget.end);
    const durationMin = oldEndDt.diff(oldStartDt, 'minutes').minutes || 30;
    const newEndDt = newStartDt.plus({ minutes: durationMin });

    setBusyId(reschedTarget.id);
    try {
      const res = await fetch('/api/developer/rescheduleMeeting', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: reschedTarget.id,
          instructor: reschedTarget.instructorSlug,
          studentEmail: reschedTarget.studentEmail,
          studentName: reschedTarget.studentName,
          oldStart: reschedTarget.start,
          newStart: newStartDt.toISO(),
          newEnd: newEndDt.toISO(),
        }),
      });
      const data = await res.json();
      if (!res.ok) alert('Reschedule failed: ' + (data.error || 'unknown'));
      setReschedTarget(null);
      await refresh();
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section style={CARD}>
      <h2 style={H2}>Upcoming meetings ({meetings.length})</h2>
      {meetings.length === 0 ? (
        <p style={{ fontSize: '13px', color: '#666' }}>No meetings in the next 8 weeks.</p>
      ) : (
        <table style={{ width: '100%', fontSize: '13px', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '1px solid #E5E3DD' }}>
              <th style={{ padding: '6px 4px' }}>When</th>
              <th style={{ padding: '6px 4px' }}>Instructor</th>
              <th style={{ padding: '6px 4px' }}>Student</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {meetings.map(m => (
              <tr key={m.id} style={{ borderBottom: '1px solid #F0EEE8' }}>
                <td style={{ padding: '8px 4px' }}>{formatPacific(m.start)}</td>
                <td style={{ padding: '8px 4px' }}>{m.instructor}</td>
                <td style={{ padding: '8px 4px' }}>
                  {m.studentName || <span style={{ color: '#888' }}>—</span>}
                  {m.studentEmail && <div style={{ fontSize: '11px', color: '#888' }}>{m.studentEmail}</div>}
                </td>
                <td style={{ padding: '8px 4px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button onClick={() => openReschedule(m)} disabled={busyId === m.id} style={{ ...BTN_GHOST, padding: '4px 12px', fontSize: '12px', marginRight: 6 }}>
                    Reschedule
                  </button>
                  <button onClick={() => cancelMeeting(m)} disabled={busyId === m.id} style={{ ...BTN_DARK, padding: '4px 12px', fontSize: '12px', backgroundColor: '#C6613F' }}>
                    Cancel
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {reschedTarget && (
        <div style={{
          position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.4)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50,
        }} onClick={() => setReschedTarget(null)}>
          <div onClick={e => e.stopPropagation()} style={{
            backgroundColor: '#FAF9F4', padding: '1.5rem', borderRadius: 12,
            maxWidth: 400, width: '90%',
          }}>
            <h3 style={{ ...H2, fontSize: 18 }}>Reschedule meeting</h3>
            <p style={{ fontSize: 13, color: '#666', marginBottom: 12 }}>
              {reschedTarget.studentName || reschedTarget.studentEmail || reschedTarget.title}<br />
              with {reschedTarget.instructor}<br />
              currently {formatPacific(reschedTarget.start)}
            </p>
            <input
              type="datetime-local"
              value={reschedValue}
              onChange={e => setReschedValue(e.target.value)}
              style={{ ...INPUT, width: '100%', marginBottom: 12 }}
            />
            <p style={{ fontSize: 11, color: '#888', marginBottom: 12 }}>
              Admin override: any time accepted. Student will be emailed.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={() => setReschedTarget(null)} style={BTN_GHOST}>Cancel</button>
              <button onClick={submitReschedule} disabled={busyId === reschedTarget.id} style={BTN_DARK}>
                {busyId === reschedTarget.id ? 'Saving…' : 'Reschedule'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function ComplianceSection({ students }) {
  const missingRyan = useMemo(() => students.filter(s => s.missingRyan).sort((a, b) => (b.daysSinceRyan ?? 9999) - (a.daysSinceRyan ?? 9999)), [students]);
  const missingAaron = useMemo(() => students.filter(s => s.missingAaron).sort((a, b) => (b.daysSinceAaron ?? 9999) - (a.daysSinceAaron ?? 9999)), [students]);
  const missingBoth = useMemo(() => students.filter(s => s.missingRyan && s.missingAaron), [students]);

  const Column = ({ title, rows, sinceField, lastField }) => (
    <div style={{ flex: 1, minWidth: 240 }}>
      <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>
        {title} ({rows.length})
      </h3>
      {rows.length === 0 ? (
        <p style={{ fontSize: 12, color: '#666' }}>Everyone's caught up.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: 12 }}>
          {rows.map(s => (
            <li key={s.email} style={{ padding: '6px 0', borderBottom: '1px solid #F0EEE8' }}>
              <div style={{ fontWeight: 600 }}>{s.name}</div>
              <div style={{ color: '#666' }}>
                {s[lastField] ? `${formatDateOnly(s[lastField])} (${s[sinceField]}d ago)` : 'Never'}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  return (
    <section style={CARD}>
      <h2 style={H2}>Check-in compliance (past 14 days)</h2>
      <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap' }}>
        <Column title="Missing Ryan" rows={missingRyan} sinceField="daysSinceRyan" lastField="lastRyan" />
        <Column title="Missing Aaron" rows={missingAaron} sinceField="daysSinceAaron" lastField="lastAaron" />
        <Column title="Missing both" rows={missingBoth} sinceField="daysSinceRyan" lastField="lastRyan" />
      </div>
    </section>
  );
}

export default function DeveloperDashboard() {
  const [usage, setUsage] = useState(null);
  const [blocks, setBlocks] = useState([]);
  const [meetings, setMeetings] = useState([]);
  const [students, setStudents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refreshAll = async () => {
    const [u, b, m, c] = await Promise.all([
      fetch('/api/developer/anthropicUsage').then(r => r.json()).catch(() => ({ enabled: false, reason: 'Network error' })),
      fetch('/api/developer/blocks').then(r => r.json()).catch(() => ({ blocks: [] })),
      fetch('/api/getUpcomingMeetings?all=true').then(r => r.json()).catch(() => ({ meetings: [] })),
      fetch('/api/developer/checkinCompliance').then(r => r.json()).catch(() => ({ students: [] })),
    ]);
    setUsage(u);
    setBlocks(b.blocks || []);
    setMeetings(m.meetings || []);
    setStudents(c.students || []);
  };

  const refreshBlocks = async () => {
    const b = await fetch('/api/developer/blocks').then(r => r.json());
    setBlocks(b.blocks || []);
  };

  const refreshMeetings = async () => {
    const m = await fetch('/api/getUpcomingMeetings?all=true').then(r => r.json());
    setMeetings(m.meetings || []);
  };

  useEffect(() => {
    refreshAll().catch(err => setError(err.message)).finally(() => setLoading(false));
  }, []);

  const addBlock = async (block) => {
    const res = await fetch('/api/developer/blocks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(block),
    });
    if (!res.ok) {
      const data = await res.json();
      alert('Add block failed: ' + (data.error || 'unknown'));
      return;
    }
    await refreshBlocks();
  };

  const deleteBlock = async (rowIndex) => {
    if (!confirm('Remove this block?')) return;
    const res = await fetch('/api/developer/blocks', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rowIndex }),
    });
    if (!res.ok) {
      const data = await res.json();
      alert('Delete failed: ' + (data.error || 'unknown'));
      return;
    }
    await refreshBlocks();
  };

  return (
    <div style={{ backgroundColor: '#F4F2EC', minHeight: '100vh' }}>
      <main style={{ padding: '2rem', maxWidth: 960, margin: '0 auto' }}>
        <h1 style={{
          fontSize: 36, fontWeight: 700, marginBottom: '0.25rem', color: '#111',
          fontFamily: "'DM Sans', 'Poppins', sans-serif",
        }}>
          Developer Dashboard
        </h1>
        <p style={{ fontSize: 13, color: '#666', marginBottom: '1.5rem', fontFamily: "'DM Sans', sans-serif" }}>
          Admin tools — only visible to {process.env.NEXT_PUBLIC_DEVELOPER_LABEL || 'the developer email'}.
        </p>

        {loading && <p style={{ fontFamily: "'DM Sans', sans-serif" }}>Loading…</p>}
        {error && <p style={{ color: '#c00', fontFamily: "'DM Sans', sans-serif" }}>{error}</p>}

        {!loading && (
          <>
            <section style={CARD}>
              <h2 style={H2}>Anthropic API usage</h2>
              <UsageWheel data={usage} />
            </section>

            <BlocksSection blocks={blocks} onAdd={addBlock} onDelete={deleteBlock} />
            <MeetingsSection meetings={meetings} refresh={refreshMeetings} />
            <ComplianceSection students={students} />
          </>
        )}
      </main>
    </div>
  );
}
