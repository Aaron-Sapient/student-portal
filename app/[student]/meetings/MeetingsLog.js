'use client'

import { useEffect, useRef, useState } from 'react'
import { DateTime } from 'luxon'
import { Plus, Check, Trash2, Lock, ArrowUpRight, Loader2 } from 'lucide-react'

const ZONE = 'America/Los_Angeles'
const HW_STATUSES = ['done', 'partly', 'not done', 'n/a']

function fmtDate(iso) {
  if (!iso) return { day: '—', rest: 'undated' }
  const d = DateTime.fromISO(iso, { zone: ZONE })
  if (!d.isValid) return { day: '—', rest: iso }
  return { day: d.toFormat('d'), rest: d.toFormat('ccc · LLL yyyy') }
}

// Textarea that grows with its content and saves on blur. Sheet-era fields hold
// multi-line notes with "-" bullets, so the raw text is the format — no editor.
function Field({ label, value, onSave, readOnly, autoFocus, placeholder, rows = 1 }) {
  const ref = useRef(null)
  // Local draft; re-seeded when the saved value changes under us (key-by-value
  // pattern instead of a setState-in-effect).
  const [draft, setDraft] = useState({ base: value ?? '', v: value ?? '' })
  const v = draft.base === (value ?? '') ? draft.v : (value ?? '')
  const setV = (nv) => setDraft({ base: value ?? '', v: nv })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${el.scrollHeight}px`
  }, [v])
  useEffect(() => {
    if (autoFocus && ref.current) {
      ref.current.focus()
      ref.current.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
  }, [autoFocus])
  return (
    <label className="block">
      <span className="mb-0.5 block text-[10px] font-semibold uppercase tracking-[0.13em] text-ink-faint">{label}</span>
      <textarea
        ref={ref}
        rows={rows}
        value={v}
        readOnly={readOnly}
        placeholder={readOnly ? '' : placeholder}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => { if ((v ?? '') !== (value ?? '')) onSave(v) }}
        className={`w-full resize-none overflow-hidden rounded-xl bg-transparent px-2 py-1 text-[15px] leading-relaxed text-ink outline-none transition-colors ${
          readOnly ? 'cursor-default' : 'hover:bg-black/[0.03] focus:bg-[var(--neu-inset-bg)] focus:shadow-[inset_2px_2px_6px_rgba(0,0,0,0.08)] dark:hover:bg-white/[0.04]'
        }`}
      />
    </label>
  )
}

function Chip({ active, children, onClick, disabled, title }) {
  return (
    <button
      type="button"
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={`rounded-full px-2.5 py-1 text-xs font-semibold transition ${
        active ? 'bg-terracotta text-white' : 'neu-chip text-ink-soft hover:text-ink'
      } disabled:cursor-default disabled:opacity-70`}
    >
      {children}
    </button>
  )
}

function Entry({ m, editable, focused, onPatch, onVoid }) {
  const [state, setState] = useState('idle') // idle | saving | saved | error
  const { day, rest } = fmtDate(m.meeting_date)
  const save = async (fields) => {
    setState('saving')
    const ok = await onPatch(m.id, fields)
    setState(ok ? 'saved' : 'error')
    if (ok) setTimeout(() => setState('idle'), 1600)
  }
  return (
    <article
      id={`m-${m.id}`}
      className={`grid grid-cols-[5rem_1fr] gap-x-3 py-5 sm:grid-cols-[5.5rem_1fr] sm:gap-x-4 ${
        focused ? 'neu-raised -mx-4 rounded-3xl px-4 sm:-mx-5 sm:px-5' : 'border-b border-ink/[0.08]'
      }`}
    >
      {/* Date rail: the number is the scan anchor; month/weekday ride underneath. */}
      <div className="pt-1">
        <p className="font-display text-3xl font-semibold leading-none text-ink">{day}</p>
        {editable ? (
          <input
            type="date"
            value={m.meeting_date ?? ''}
            onChange={(e) => save({ meeting_date: e.target.value || null })}
            aria-label="Meeting date"
            className="mt-1 w-full bg-transparent text-[11px] font-medium leading-tight text-ink-faint outline-none focus:text-ink [&::-webkit-calendar-picker-indicator]:hidden"
          />
        ) : (
          <p className="mt-1 text-[11px] font-medium leading-tight text-ink-faint">{rest}</p>
        )}
        <div className="mt-2 flex flex-wrap gap-1">
          {['Aaron', 'Ryan'].map((t) => (
            <Chip key={t} active={m.teacher === t} disabled={!editable} onClick={() => save({ teacher: t })}>
              {t}
            </Chip>
          ))}
        </div>
      </div>

      <div className="min-w-0 space-y-2">
        <Field label="Project" value={m.project} readOnly={!editable} placeholder="Common App · ACT Reading · …" onSave={(v) => save({ project: v })} />
        <Field label="Agenda" value={m.agenda} readOnly={!editable} autoFocus={focused} placeholder="What we did" rows={2} onSave={(v) => save({ agenda: v })} />
        <Field label="Homework" value={m.homework} readOnly={!editable} placeholder="What they owe" rows={2} onSave={(v) => save({ homework: v })} />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pt-1">
          <span className="text-[10px] font-semibold uppercase tracking-[0.13em] text-ink-faint">HW</span>
          {HW_STATUSES.map((s) => (
            <Chip key={s} active={m.hw_status === s} disabled={!editable} onClick={() => save({ hw_status: m.hw_status === s ? null : s })}>
              {s}
            </Chip>
          ))}
          <label className="ml-auto flex items-center gap-1.5 text-xs text-ink-soft">
            <span className="text-[10px] font-semibold uppercase tracking-[0.13em] text-ink-faint">%</span>
            <input
              defaultValue={m.pct ?? ''}
              readOnly={!editable}
              placeholder="—"
              onBlur={(e) => { const v = e.target.value.trim(); if (v !== (m.pct ?? '')) save({ pct: v || null }) }}
              className="w-14 rounded-lg bg-transparent px-1.5 py-0.5 text-right text-sm text-ink outline-none focus:bg-[var(--neu-inset-bg)] focus:shadow-[inset_2px_2px_6px_rgba(0,0,0,0.08)]"
              aria-label="Percent complete"
            />
          </label>
          <span className="flex h-5 w-5 items-center justify-center" aria-live="polite">
            {state === 'saving' && <Loader2 className="h-4 w-4 animate-spin text-ink-faint" />}
            {state === 'saved' && <Check className="h-4 w-4 text-moss" />}
            {state === 'error' && <span className="text-xs font-semibold text-terracotta-deep">not saved</span>}
          </span>
          {editable && m.source === 'portal' && (
            <button
              type="button"
              onClick={() => onVoid(m.id)}
              title="Remove this entry"
              aria-label="Remove this entry"
              className="flex h-8 w-8 items-center justify-center rounded-full text-ink-faint transition hover:text-terracotta-deep"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </div>
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
    <>
      <header className="mb-6 flex flex-wrap items-end gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold uppercase tracking-[0.13em] text-ink-soft">Meetings</p>
          <h1 className="font-display text-3xl font-semibold leading-tight text-ink sm:text-4xl">
            {student.name} <span className="text-ink-faint">{student.klass}</span>
          </h1>
          <p className="mt-1 flex items-center gap-1.5 text-sm text-ink-soft">
            {portalOwned ? (
              <>{rows.length} meetings · the log lives here</>
            ) : (
              <><Lock className="h-3.5 w-3.5" /> read-only · this log still lives in the sheet
                {student.portalUrl && (
                  <a href={student.portalUrl} target="_blank" rel="noopener noreferrer" className="ml-1 inline-flex items-center gap-0.5 font-semibold text-terracotta-deep">
                    open sheet <ArrowUpRight className="h-3.5 w-3.5" />
                  </a>
                )}
              </>
            )}
          </p>
        </div>
        {editable && (
          <button
            type="button"
            onClick={todayRow ? () => setFocus(todayRow.id) : newMeeting}
            disabled={busy}
            style={{ backgroundColor: 'var(--color-terracotta)' }}
            className="flex items-center gap-2 rounded-full px-4 py-2.5 text-sm font-semibold text-white shadow-[0_6px_16px_-6px_rgba(0,0,0,0.45)] transition hover:brightness-105 active:scale-95 disabled:opacity-60"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" strokeWidth={2.5} />}
            {todayRow ? 'Today’s entry' : 'New meeting'}
          </button>
        )}
      </header>
      {err && <p className="mb-4 text-sm font-semibold text-terracotta-deep">{err}</p>}

      <section aria-label="Meeting log">
        {rows.map((m) => (
          <Entry key={m.id} m={m} editable={editable} focused={m.id === focus} onPatch={patch} onVoid={voidRow} />
        ))}
        {!rows.length && <p className="py-10 text-center text-sm text-ink-faint">No meetings logged yet.</p>}
      </section>
    </>
  )
}
