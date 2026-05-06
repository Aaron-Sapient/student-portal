'use client';
import { useEffect, useState, useMemo, useRef } from 'react';
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

  // Default window: today through 14 days out, in Pacific time, to avoid the
  // off-by-one drift you get if you let the browser do date math in UTC.
  const todayPT = DateTime.now().setZone('America/Los_Angeles').toFormat('yyyy-LL-dd');
  const twoWeeksPT = DateTime.now().setZone('America/Los_Angeles').plus({ days: 14 }).toFormat('yyyy-LL-dd');
  const [startDate, setStartDate] = useState(todayPT);
  const [endDate, setEndDate] = useState(twoWeeksPT);
  const [showAaron, setShowAaron] = useState(true);
  const [showRyan, setShowRyan] = useState(true);
  const [show15, setShow15] = useState(true);
  const [show30, setShow30] = useState(true);
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const startBound = startDate
      ? DateTime.fromISO(startDate, { zone: 'America/Los_Angeles' }).startOf('day')
      : null;
    const endBound = endDate
      ? DateTime.fromISO(endDate, { zone: 'America/Los_Angeles' }).endOf('day')
      : null;

    return meetings.filter(m => {
      const startDt = DateTime.fromISO(m.start).setZone('America/Los_Angeles');
      if (startBound && startDt < startBound) return false;
      if (endBound && startDt > endBound) return false;

      // Instructor: Aaron/Ryan gated on their checkbox; ART always passes through
      // since the user only asked for the two named instructors.
      const instr = (m.instructor || '').toLowerCase();
      if (instr === 'aaron' && !showAaron) return false;
      if (instr === 'ryan' && !showRyan) return false;

      // Duration: 15min/30min gated on their checkbox; other durations
      // (email, null, art slots) always pass through.
      if (m.duration === '15min' && !show15) return false;
      if (m.duration === '30min' && !show30) return false;

      if (q) {
        const name = (m.studentName || '').toLowerCase();
        const emailStr = (m.studentEmail || '').toLowerCase();
        if (!name.includes(q) && !emailStr.includes(q)) return false;
      }
      return true;
    });
  }, [meetings, startDate, endDate, showAaron, showRyan, show15, show30, search]);

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

  const checkboxLabel = {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    fontSize: 13, cursor: 'pointer', userSelect: 'none',
  };

  return (
    <section style={CARD}>
      <h2 style={H2}>Upcoming meetings</h2>

      <div style={{
        display: 'flex', flexWrap: 'wrap', alignItems: 'center',
        gap: '0.75rem 1.25rem', marginBottom: '0.75rem',
        paddingBottom: '0.75rem', borderBottom: '1px solid #E5E3DD',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} style={INPUT} />
          <span style={{ fontSize: 13, color: '#666' }}>to</span>
          <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} style={INPUT} />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <label style={checkboxLabel}>
            <input type="checkbox" checked={showAaron} onChange={e => setShowAaron(e.target.checked)} style={{ accentColor: '#C6613F', cursor: 'pointer' }} />
            Aaron
          </label>
          <label style={checkboxLabel}>
            <input type="checkbox" checked={showRyan} onChange={e => setShowRyan(e.target.checked)} style={{ accentColor: '#C6613F', cursor: 'pointer' }} />
            Ryan
          </label>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <label style={checkboxLabel}>
            <input type="checkbox" checked={show15} onChange={e => setShow15(e.target.checked)} style={{ accentColor: '#C6613F', cursor: 'pointer' }} />
            15min
          </label>
          <label style={checkboxLabel}>
            <input type="checkbox" checked={show30} onChange={e => setShow30(e.target.checked)} style={{ accentColor: '#C6613F', cursor: 'pointer' }} />
            30min
          </label>
        </div>

        <input
          type="search"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search student…"
          style={{
            ...INPUT, borderRadius: 999, padding: '6px 12px',
            marginLeft: 'auto', minWidth: 200, flex: '0 1 240px',
          }}
        />
      </div>

      {filtered.length === 0 ? (
        <p style={{ fontSize: '13px', color: '#666' }}>No meetings match the current filters.</p>
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
            {filtered.map(m => (
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

// Auto-grows to fit its content so cells never show an internal vertical scrollbar.
// Resizes on every value change and on initial mount.
function AutoResizingTextarea({ value, onChange, onBlur, style }) {
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  return (
    <textarea
      ref={ref}
      value={value}
      onChange={onChange}
      onBlur={onBlur}
      style={{
        width: '100%',
        minHeight: 120,
        overflow: 'hidden',
        resize: 'none',
        padding: 8,
        border: '1px solid #E5E3DD',
        borderRadius: 6,
        fontFamily: 'inherit',
        fontSize: 12,
        lineHeight: 1.5,
        boxSizing: 'border-box',
        ...style,
      }}
    />
  );
}

function ReportRow({ report, onPatch, onUpload, busy }) {
  // Local state lets us debounce sheet writes to blur and avoid re-rendering the
  // textarea every keystroke from parent state. We sync from props on rowIndex change.
  const [local, setLocal] = useState({
    onTarget: report.onTarget,
    needsAttention: report.needsAttention,
    strategy: report.strategy,
    parentRequests: report.parentRequests,
  });

  useEffect(() => {
    setLocal({
      onTarget: report.onTarget,
      needsAttention: report.needsAttention,
      strategy: report.strategy,
      parentRequests: report.parentRequests,
    });
  }, [report.rowIndex, report.onTarget, report.needsAttention, report.strategy, report.parentRequests]);

  const cell = (field) => (
    <td style={{ padding: '6px 4px', verticalAlign: 'top' }}>
      <AutoResizingTextarea
        value={local[field]}
        onChange={e => setLocal(s => ({ ...s, [field]: e.target.value }))}
        onBlur={() => {
          if (local[field] !== report[field]) onPatch(report.rowIndex, field, local[field]);
        }}
      />
    </td>
  );

  const buttonLabel = busy
    ? (report.status ? 'Re-uploading…' : 'Uploading…')
    : (report.status ? 'Revise' : 'Upload');

  return (
    <tr style={{ borderBottom: '1px solid #F0EEE8' }}>
      <td style={{ padding: '8px 4px', verticalAlign: 'top', whiteSpace: 'nowrap', fontSize: 12 }}>
        {formatDateOnly(report.date)}
      </td>
      <td style={{ padding: '8px 4px', verticalAlign: 'top', fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap' }}>
        {report.student}
      </td>
      {cell('onTarget')}
      {cell('needsAttention')}
      {cell('strategy')}
      {cell('parentRequests')}
      <td style={{ padding: '8px 4px', verticalAlign: 'top', whiteSpace: 'nowrap' }}>
        <button
          onClick={() => onUpload(report)}
          disabled={busy}
          style={{
            backgroundColor: '#C6613F', color: '#fff',
            padding: '8px 18px', borderRadius: '999px', border: 'none',
            fontWeight: 600, cursor: busy ? 'wait' : 'pointer',
            fontFamily: "'DM Sans', sans-serif", fontSize: 13,
            opacity: busy ? 0.7 : 1,
          }}
        >
          {buttonLabel}
        </button>
      </td>
    </tr>
  );
}

function WrittenReportsSection({ reports, refresh }) {
  const [busyRow, setBusyRow] = useState(null);
  const [unsentOnly, setUnsentOnly] = useState(false);
  const [search, setSearch] = useState('');

  const patch = async (rowIndex, field, value) => {
    try {
      await fetch('/api/developer/writtenReports', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rowIndex, field, value }),
      });
    } catch (err) {
      alert('Save failed: ' + err.message);
    }
  };

  const upload = async (report) => {
    const verb = report.status ? 'Re-upload to' : 'Upload to';
    if (!confirm(`${verb} ${report.student}'s Google Sheet?`)) return;
    setBusyRow(report.rowIndex);
    try {
      const res = await fetch('/api/developer/writtenReports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rowIndex: report.rowIndex }),
      });
      const data = await res.json();
      if (!res.ok) alert('Upload failed: ' + (data.error || 'unknown'));
      await refresh();
    } finally {
      setBusyRow(null);
    }
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return reports.filter(r => {
      if (unsentOnly && r.status) return false;
      if (q && !String(r.student).toLowerCase().includes(q)) return false;
      return true;
    });
  }, [reports, unsentOnly, search]);

  // Distinguish "unsent filter on AND zero unsent reports anywhere" (celebration)
  // from "filters knocked everything out for some other reason" (generic message).
  const allCaughtUp = unsentOnly && reports.every(r => r.status);

  return (
    <section style={CARD}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.75rem', marginBottom: '0.75rem' }}>
        <h2 style={{ ...H2, marginBottom: 0 }}>Written Reports</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', fontSize: 13 }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', userSelect: 'none' }}>
            <input
              type="checkbox"
              checked={unsentOnly}
              onChange={e => setUnsentOnly(e.target.checked)}
              style={{ accentColor: '#C6613F', cursor: 'pointer' }}
            />
            Unsent only
          </label>
          <input
            type="search"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search student…"
            style={{
              padding: '6px 12px',
              border: '1px solid #B4B3B0',
              borderRadius: '999px',
              fontFamily: 'inherit',
              fontSize: 13,
              minWidth: 200,
            }}
          />
        </div>
      </div>

      {reports.length === 0 ? (
        <p style={{ fontSize: 13, color: '#666' }}>No written reports yet.</p>
      ) : allCaughtUp ? (
        <div style={{ textAlign: 'center', padding: '2.5rem 0' }}>
          <img
            src="https://res.cloudinary.com/drgtneken/image/upload/v1778018446/empty_box_olfq9a.png"
            alt=""
            style={{ maxWidth: 180, width: '100%', height: 'auto', display: 'block', margin: '0 auto' }}
          />
          <p style={{
            marginTop: '1rem',
            fontSize: 15,
            fontWeight: 600,
            color: '#3c3c3c',
            fontFamily: "'DM Sans', sans-serif",
          }}>
            No unsent reports. Great job!
          </p>
        </div>
      ) : filtered.length === 0 ? (
        <p style={{ fontSize: 13, color: '#666' }}>No reports match the current filters.</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, tableLayout: 'fixed' }}>
            <colgroup>
              <col style={{ width: 110 }} />
              <col style={{ width: 140 }} />
              <col />
              <col />
              <col />
              <col />
              <col style={{ width: 130 }} />
            </colgroup>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid #E5E3DD' }}>
                <th style={{ padding: '6px 4px' }}>Date</th>
                <th style={{ padding: '6px 4px' }}>Student</th>
                <th style={{ padding: '6px 4px' }}>On Target</th>
                <th style={{ padding: '6px 4px' }}>Needs Attention</th>
                <th style={{ padding: '6px 4px' }}>Strategy &amp; Recs</th>
                <th style={{ padding: '6px 4px' }}>Parent Requests</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(r => (
                <ReportRow
                  key={r.rowIndex}
                  report={r}
                  onPatch={patch}
                  onUpload={upload}
                  busy={busyRow === r.rowIndex}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ComplianceSection({ students }) {
  const missingRyan = useMemo(() => students.filter(s => s.missingRyan).sort((a, b) => (b.daysSinceRyan ?? 9999) - (a.daysSinceRyan ?? 9999)), [students]);
  const missingAaron = useMemo(() => students.filter(s => s.missingAaron).sort((a, b) => (b.daysSinceAaron ?? 9999) - (a.daysSinceAaron ?? 9999)), [students]);
  const missingBoth = useMemo(() => students.filter(s => s.missingRyan && s.missingAaron), [students]);
  const recipientCount = useMemo(
    () => students.filter(s => s.missingRyan || s.missingAaron).length,
    [students]
  );

  const [sending, setSending] = useState(null); // 'ryan' | 'aaron' | 'both' | null

  const sendReminders = async (which) => {
    const labels = { ryan: 'Ryan', aaron: 'Aaron', both: 'both Ryan and Aaron' };
    if (!confirm(
      `Send a check-in reminder to ${recipientCount} student(s) and BCC ${labels[which]}? ` +
      `This emails every student who's behind on at least one weekly check-in.`
    )) return;

    setSending(which);
    try {
      const res = await fetch('/api/developer/sendCheckinReminders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bccRyan: which === 'ryan' || which === 'both',
          bccAaron: which === 'aaron' || which === 'both',
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert('Send failed: ' + (data.error || 'unknown'));
        return;
      }
      const failedNote = data.failedCount
        ? `\n\n${data.failedCount} failed:\n${data.failed.map(f => `• ${f.email}: ${f.error}`).join('\n')}`
        : '';
      alert(`Sent ${data.sentCount} of ${data.total} reminders. BCC: ${data.bcc.join(', ')}.${failedNote}`);
    } catch (err) {
      alert('Send failed: ' + err.message);
    } finally {
      setSending(null);
    }
  };

  const reminderBtn = {
    ...BTN_DARK, padding: '6px 14px', fontSize: 12,
  };

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

      <div style={{
        display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.5rem 0.75rem',
        marginBottom: '1rem', paddingBottom: '0.75rem', borderBottom: '1px solid #E5E3DD',
      }}>
        <span style={{ fontSize: 13, color: '#444', marginRight: 4 }}>
          Email reminder to <strong>{recipientCount}</strong> student(s) behind on a check-in. BCC:
        </span>
        <button
          onClick={() => sendReminders('ryan')}
          disabled={sending !== null || recipientCount === 0}
          style={{ ...reminderBtn, opacity: sending !== null || recipientCount === 0 ? 0.5 : 1 }}
        >
          {sending === 'ryan' ? 'Sending…' : 'BCC Ryan'}
        </button>
        <button
          onClick={() => sendReminders('aaron')}
          disabled={sending !== null || recipientCount === 0}
          style={{ ...reminderBtn, opacity: sending !== null || recipientCount === 0 ? 0.5 : 1 }}
        >
          {sending === 'aaron' ? 'Sending…' : 'BCC Aaron'}
        </button>
        <button
          onClick={() => sendReminders('both')}
          disabled={sending !== null || recipientCount === 0}
          style={{ ...reminderBtn, opacity: sending !== null || recipientCount === 0 ? 0.5 : 1 }}
        >
          {sending === 'both' ? 'Sending…' : 'BCC Ryan + Aaron'}
        </button>
      </div>

      <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap' }}>
        <Column title="Missing Ryan" rows={missingRyan} sinceField="daysSinceRyan" lastField="lastRyan" />
        <Column title="Missing Aaron" rows={missingAaron} sinceField="daysSinceAaron" lastField="lastAaron" />
        <Column title="Missing both" rows={missingBoth} sinceField="daysSinceRyan" lastField="lastRyan" />
      </div>
    </section>
  );
}

export default function DeveloperDashboard() {
  const [blocks, setBlocks] = useState([]);
  const [meetings, setMeetings] = useState([]);
  const [students, setStudents] = useState([]);
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refreshAll = async () => {
    const [b, m, c, r] = await Promise.all([
      fetch('/api/developer/blocks').then(r => r.json()).catch(() => ({ blocks: [] })),
      fetch('/api/getUpcomingMeetings?all=true').then(r => r.json()).catch(() => ({ meetings: [] })),
      fetch('/api/developer/checkinCompliance').then(r => r.json()).catch(() => ({ students: [] })),
      fetch('/api/developer/writtenReports').then(r => r.json()).catch(() => ({ reports: [] })),
    ]);
    setBlocks(b.blocks || []);
    setMeetings(m.meetings || []);
    setStudents(c.students || []);
    setReports(r.reports || []);
  };

  const refreshReports = async () => {
    const r = await fetch('/api/developer/writtenReports').then(r => r.json());
    setReports(r.reports || []);
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
      <main style={{ padding: '2rem clamp(1rem, 3vw, 3rem)', maxWidth: 1800, margin: '0 auto' }}>
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
            <BlocksSection blocks={blocks} onAdd={addBlock} onDelete={deleteBlock} />
            <WrittenReportsSection reports={reports} refresh={refreshReports} />
            <MeetingsSection meetings={meetings} refresh={refreshMeetings} />
            <ComplianceSection students={students} />
          </>
        )}
      </main>
    </div>
  );
}
