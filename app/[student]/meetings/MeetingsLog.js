'use client'

import { useEffect, useRef, useState } from 'react'
import { DateTime } from 'luxon'
import { Plus, Check, Trash2, Lock, ArrowUpRight, Loader2 } from 'lucide-react'

const ZONE = 'America/Los_Angeles'
// value sent to the API -> label shown in the segmented control
const HW_STATUSES = [
  ['done', 'Done'],
  ['partly', 'Partly'],
  ['not done', 'Not done'],
  ['n/a', 'N/A'],
]
const TEACHERS = ['Aaron', 'Ryan']
const HW_CLAMP_LINES = 6

// The weekday rides beside the numeral at BOTH read-only and editable widths —
// "was that a Tuesday?" is a question a counselor actually asks of this log, and
// the native date input cannot answer it.
function fmtDate(iso) {
  if (!iso) return { day: '—', weekday: '', monthYear: 'undated' }
  const d = DateTime.fromISO(iso, { zone: ZONE })
  if (!d.isValid) return { day: '—', weekday: '', monthYear: iso }
  return { day: d.toFormat('d'), weekday: d.toFormat('ccc'), monthYear: d.toFormat('LLL yyyy') }
}

// A textarea that looks like text until you touch it: grows with its content and
// saves on blur. Sheet-era fields hold multi-line notes with "-" bullets, so the
// raw text IS the format — no editor. `clampLines` caps the rendered height and
// exposes an inline "more" (homework runs to 40 lines and cannot be allowed to
// set the row height for the whole log).
function Field({ className, label, value, onSave, readOnly, autoFocus, placeholder, rows = 1, clampLines = 0, ariaLabel }) {
  const ref = useRef(null)
  // Local draft; re-seeded when the saved value changes under us (key-by-value
  // pattern instead of a setState-in-effect).
  const [draft, setDraft] = useState({ base: value ?? '', v: value ?? '' })
  const [expanded, setExpanded] = useState(false)
  const [focused, setFocused] = useState(false)
  const [overflowing, setOverflowing] = useState(false)
  const v = draft.base === (value ?? '') ? draft.v : (value ?? '')
  const setV = (nv) => setDraft({ base: value ?? '', v: nv })

  // Autosize + clamp in one pass: measure the natural height, then either use it
  // or pin to `clampLines`. Focus always un-clamps, so typing past line 6 is never
  // hidden from the person typing it.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = '0px'
    const full = el.scrollHeight
    if (!clampLines) {
      el.style.height = `${full}px`
      return
    }
    const cs = getComputedStyle(el)
    const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5 || 20
    const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0)
    const cap = Math.round(lh * clampLines + pad)
    const over = full > cap + 1
    setOverflowing(over)
    el.style.height = `${over && !expanded && !focused ? cap : full}px`
  }, [v, clampLines, expanded, focused])

  useEffect(() => {
    if (autoFocus && ref.current) {
      ref.current.focus()
      ref.current.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
  }, [autoFocus])

  return (
    <div className={className}>
      {label && <span className="mtg-inline-label">{label}</span>}
      <textarea
        ref={ref}
        rows={rows}
        value={v}
        readOnly={readOnly}
        aria-label={ariaLabel || label}
        placeholder={readOnly ? '—' : placeholder}
        onChange={(e) => setV(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false)
          if ((v ?? '') !== (value ?? '')) onSave(v)
        }}
        className="mtg-field"
      />
      {clampLines > 0 && overflowing && !focused && (
        <button type="button" className="mtg-more" onClick={() => setExpanded((x) => !x)}>
          {expanded ? 'less' : 'more'}
        </button>
      )}
    </div>
  )
}

// One control idiom, two uses (counselor, homework status): which segment is
// filled IS the value, so a column of these reads straight down without a legend.
function Seg({ options, value, onPick, label, modifier }) {
  return (
    <div className={`mtg-seg${modifier ? ` ${modifier}` : ''}`} role="group" aria-label={label}>
      {options.map(([val, text]) => (
        <button key={val} type="button" aria-pressed={value === val} onClick={() => onPick(val)}>
          {text}
        </button>
      ))}
    </div>
  )
}

function Entry({ m, editable, focused, onPatch, onVoid }) {
  const [state, setState] = useState('idle') // idle | saving | saved | error
  const { day, weekday, monthYear } = fmtDate(m.meeting_date)
  const save = async (fields) => {
    setState('saving')
    const ok = await onPatch(m.id, fields)
    setState(ok ? 'saved' : 'error')
    if (ok) setTimeout(() => setState('idle'), 1600)
  }
  const statusLabel = HW_STATUSES.find(([val]) => val === m.hw_status)?.[1]

  return (
    <article id={`m-${m.id}`} className={`mtg-row${focused ? ' is-focused' : ''}`}>
      {/* Date rail — the scan spine. The numeral is the anchor; everything that
          qualifies it (weekday, month, who) rides underneath at label size. */}
      <div className="mtg-c-date">
        <div className="mtg-datehead">
          <p className="mtg-day">{day}</p>
          <p className="mtg-when">{weekday || monthYear}</p>
        </div>
        {editable ? (
          <input
            type="date"
            value={m.meeting_date ?? ''}
            onChange={(e) => save({ meeting_date: e.target.value || null })}
            aria-label="Meeting date"
            className="mtg-datefield"
          />
        ) : (
          weekday && <p className="mtg-when mtg-when-my">{monthYear}</p>
        )}
        <div className="mtg-who">
          {editable ? (
            <Seg
              modifier="mtg-seg--who"
              label="Counselor"
              options={TEACHERS.map((t) => [t, t])}
              value={m.teacher}
              onPick={(t) => save({ teacher: t })}
            />
          ) : (
            m.teacher && <p className="mtg-who-ro">{m.teacher}</p>
          )}
        </div>
      </div>

      <Field
        className="mtg-c-project mtg-project"
        label="Project"
        value={m.project}
        readOnly={!editable}
        placeholder="Common App · ACT Reading · …"
        onSave={(val) => save({ project: val })}
      />

      <Field
        className="mtg-c-agenda mtg-agenda"
        label="Agenda"
        value={m.agenda}
        readOnly={!editable}
        autoFocus={focused}
        placeholder="What we did"
        rows={1}
        onSave={(val) => save({ agenda: val })}
      />

      <Field
        className="mtg-c-hw mtg-hw"
        label="Homework"
        value={m.homework}
        readOnly={!editable}
        placeholder="What they owe"
        rows={1}
        clampLines={HW_CLAMP_LINES}
        onSave={(val) => save({ homework: val })}
      />

      <div className="mtg-c-status">
        {editable ? (
          <Seg
            label="Homework status"
            options={HW_STATUSES}
            value={m.hw_status}
            onPick={(val) => save({ hw_status: m.hw_status === val ? null : val })}
          />
        ) : (
          statusLabel && <p className="mtg-status-ro">{statusLabel}</p>
        )}
        {/* Read-only rows get a value, not an empty field: a blank input with a
            rule under it reads as "someone forgot to fill this in". */}
        {editable ? (
          <div className="mtg-statusline">
            <span className="mtg-savestate" aria-live="polite">
              {state === 'saving' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {state === 'saved' && <Check className="h-3.5 w-3.5" style={{ color: 'var(--color-moss)' }} />}
              {state === 'error' && <span className="mtg-savestate-err">not saved</span>}
            </span>
            <span className="mtg-pctwrap">
              <input
                defaultValue={m.pct ?? ''}
                placeholder="—"
                onBlur={(e) => {
                  const val = e.target.value.trim()
                  if (val !== (m.pct ?? '')) save({ pct: val || null })
                }}
                className="mtg-pct"
                aria-label="Percent complete"
              />
              <span className="mtg-pctsign" aria-hidden>%</span>
            </span>
            {m.source === 'portal' && (
              <button type="button" onClick={() => onVoid(m.id)} title="Remove this entry" aria-label="Remove this entry" className="mtg-void">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        ) : (
          m.pct && <p className="mtg-pct-ro">{m.pct}%</p>
        )}
      </div>
    </article>
  )
}

export default function MeetingsLog({ student, portalOwned, me, today, initial, focusId }) {
  const [rows, setRows] = useState(initial)
  const [focus, setFocus] = useState(focusId)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const editable = portalOwned && !!me

  const patch = async (id, fields) => {
    const res = await fetch('/api/staff/meetings', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, fields }),
    })
    if (!res.ok) return false
    const { meeting } = await res.json()
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...meeting } : r)))
    return true
  }
  const voidRow = async (id) => {
    const res = await fetch('/api/staff/meetings', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
    })
    if (res.ok) setRows((rs) => rs.filter((r) => r.id !== id))
  }
  const newMeeting = async () => {
    setBusy(true); setErr(null)
    try {
      const res = await fetch('/api/staff/meetings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ studentId: student.id }),
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error || 'Could not create')
      setRows((rs) => (rs.some((r) => r.id === j.meeting.id) ? rs : [j.meeting, ...rs]))
      setFocus(j.meeting.id)
    } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }

  const todayRow = rows.find((r) => r.meeting_date === today && r.teacher === me)

  return (
    <div className="mtg-log">
      <header className="mtg-head">
        <div className="mtg-head-text">
          <p className="mtg-eyebrow">Meetings</p>
          <h1 className="mtg-title">
            {student.name} <span className="mtg-klass">{student.klass}</span>
          </h1>
          <p className="mtg-count">
            {portalOwned ? (
              <>{rows.length} meetings · the log lives here</>
            ) : (
              <><Lock className="h-3.5 w-3.5" /> read-only · this log still lives in the sheet
                {student.portalUrl && (
                  <a href={student.portalUrl} target="_blank" rel="noopener noreferrer">
                    open sheet <ArrowUpRight className="h-3.5 w-3.5" />
                  </a>
                )}
              </>
            )}
          </p>
        </div>
        {editable && (
          <button type="button" onClick={todayRow ? () => setFocus(todayRow.id) : newMeeting} disabled={busy} className="mtg-new">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" strokeWidth={2.5} />}
            {todayRow ? 'Today’s entry' : 'New meeting'}
          </button>
        )}
      </header>
      {err && <p className="mtg-error">{err}</p>}

      <section aria-label="Meeting log">
        {/* The field labels live here, once, at label size — instead of being
            repeated inside every row at the same size as the content. */}
        <div className="mtg-cols" aria-hidden>
          <span>Date</span>
          <span>Project</span>
          <span>Agenda</span>
          <span>Homework</span>
          <span className="mtg-col-status">Status</span>
        </div>
        {rows.map((m) => (
          <Entry key={m.id} m={m} editable={editable} focused={m.id === focus} onPatch={patch} onVoid={voidRow} />
        ))}
        {!rows.length && <p className="mtg-empty-list">No meetings logged yet.</p>}
      </section>
    </div>
  )
}
