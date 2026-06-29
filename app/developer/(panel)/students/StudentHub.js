'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import { DateTime } from 'luxon';
import {
  CalendarDays,
  CalendarPlus,
  Check,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  FilePen,
  FileText,
  GraduationCap,
  Loader2,
  FlaskConical,
} from 'lucide-react';
import { Halo } from '@/app/(portal)/neu';
import { Badge, Card, EmptyNote, ErrorNote, PageHeader, TabSkeleton } from '../devUi';

// The per-student hub (slug = sheet id). One scrollable page aggregating the
// student's identity, holistic scores, check-in cadence, files, read-only meeting
// agenda, and transcript status. Shared by /developer/students/[sheetId] and the
// Ryan-facing /dev/students/[sheetId]; the back-link and the "full scoring" link
// derive from the pathname so both surfaces work from one component.

const ZONE = 'America/Los_Angeles';

function fmtDate(iso, withWeekday = true) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      ...(withWeekday ? { weekday: 'short' } : {}),
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}

function daysAgo(iso) {
  const d = DateTime.fromISO(iso, { zone: ZONE });
  if (!d.isValid) return null;
  return Math.round(DateTime.now().setZone(ZONE).diff(d, 'days').days);
}

const SUBS = [
  { key: 'academic', label: 'Academic', cls: 'text-moss' },
  { key: 'ec', label: 'Extracurr.', cls: 'text-ochre' },
  { key: 'leadership', label: 'Leadership', cls: 'text-terracotta-soft' },
];

// Grant a one-off meeting that bypasses the check-in gate and unlocks booking in the
// student's Meetings tab. Regular students get a Master-sheet booking token; seniors
// get a separate additive one-off grant (never touches their weekly cadence). The
// server auto-detects which. Then the student is emailed a booking link.
function Pill({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 rounded-2xl px-4 py-2.5 text-sm font-semibold transition active:scale-[0.98] ${
        active ? 'bg-terracotta text-paper shadow-sm' : 'neu-chip text-ink'
      }`}
    >
      {children}
    </button>
  );
}

function GrantMeetingCard({ sheetId, studentName }) {
  const [instructor, setInstructor] = useState('ryan');
  const [minutes, setMinutes] = useState(30);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null); // { ok, message } | { error }

  async function grant() {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch('/api/admin/grantBooking', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentSheetId: sheetId, instructor, minutes, note: note.trim() }),
      });
      const d = await res.json();
      if (!res.ok || d.error) setResult({ error: d.error || 'Grant failed' });
      else {
        setResult({ ok: true, message: d.message });
        setNote('');
      }
    } catch {
      setResult({ error: 'Grant failed — try again.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mt-5" delay={60}>
      <h2 className="mb-1 flex items-center gap-2 font-display text-lg font-semibold text-ink">
        <CalendarPlus className="h-5 w-5 text-terracotta" strokeWidth={2} /> Grant a one-off meeting
      </h2>
      <p className="mb-3 text-[12px] leading-relaxed text-ink-soft">
        Unlocks booking now — no check-in needed. {studentName ? studentName.split(' ')[0] : 'The student'} gets
        an email with a link to pick a time. Seniors get an extra meeting on a separate track from their weekly cadence.
      </p>

      <div className="space-y-2.5">
        <div className="flex gap-2">
          <Pill active={instructor === 'ryan'} onClick={() => setInstructor('ryan')}>Ryan</Pill>
          <Pill active={instructor === 'aaron'} onClick={() => setInstructor('aaron')}>Aaron</Pill>
        </div>
        <div className="flex gap-2">
          <Pill active={minutes === 15} onClick={() => setMinutes(15)}>15-min</Pill>
          <Pill active={minutes === 30} onClick={() => setMinutes(30)}>30-min</Pill>
        </div>
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value.slice(0, 80))}
          placeholder="Reason (optional) — e.g. essay deadline this week"
          className="neu-inset w-full rounded-2xl px-4 py-2.5 text-[14px] text-ink outline-none transition placeholder:text-ink-faint focus:ring-2 focus:ring-terracotta/25"
        />
      </div>

      <button
        type="button"
        onClick={grant}
        disabled={busy}
        className="mt-3 flex w-full items-center justify-center gap-2 rounded-full bg-terracotta px-5 py-3 text-sm font-bold text-paper shadow-lift transition active:scale-[0.98] disabled:opacity-60"
      >
        {busy ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2.4} /> Granting…
          </>
        ) : (
          <>
            <CalendarPlus className="h-4 w-4" strokeWidth={2.4} /> Grant {minutes}-min with{' '}
            {instructor === 'ryan' ? 'Ryan' : 'Aaron'}
          </>
        )}
      </button>

      {result?.error && <p className="mt-2.5 text-[13px] font-medium text-terracotta-deep">{result.error}</p>}
      {result?.ok && (
        <p className="mt-2.5 flex items-start gap-1.5 text-[13px] font-medium text-moss">
          <Check className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={2.4} />
          <span>{result.message}</span>
        </p>
      )}
    </Card>
  );
}

// Set up a STANDING weekly project meeting (solo research, etc.) — a separate, additive
// track from the senior essay cadence and the one-off grant. Creates a recurring plan;
// the student gets a "Project meeting" card they book once per week. Stopgap for the
// eventual "assign students to projects + designate leads/co-leads" model.
function ProjectMeetingCard({ sheetId, studentName }) {
  const [instructor, setInstructor] = useState('aaron');
  const [minutes, setMinutes] = useState(30);
  const [label, setLabel] = useState('Solo Research');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  async function grant() {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch('/api/admin/grantProjectMeeting', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentSheetId: sheetId, instructor, minutes, label: label.trim() }),
      });
      const d = await res.json();
      if (!res.ok || d.error) setResult({ error: d.error || 'Setup failed' });
      else setResult({ ok: true, message: d.message });
    } catch {
      setResult({ error: 'Setup failed — try again.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mt-5" delay={70}>
      <h2 className="mb-1 flex items-center gap-2 font-display text-lg font-semibold text-ink">
        <FlaskConical className="h-5 w-5 text-terracotta" strokeWidth={2} /> Set up a weekly project meeting
      </h2>
      <p className="mb-3 text-[12px] leading-relaxed text-ink-soft">
        A standing weekly meeting for solo research / project work — separate from
        {studentName ? ` ${studentName.split(' ')[0]}’s` : ' the'} check-in &amp; college-app cadence. They’ll
        book it once per week (1/week). Works for seniors and non-seniors alike.
      </p>

      <div className="space-y-2.5">
        <div className="flex gap-2">
          <Pill active={instructor === 'aaron'} onClick={() => setInstructor('aaron')}>Aaron</Pill>
          <Pill active={instructor === 'ryan'} onClick={() => setInstructor('ryan')}>Ryan</Pill>
        </div>
        <div className="flex gap-2">
          <Pill active={minutes === 15} onClick={() => setMinutes(15)}>15-min</Pill>
          <Pill active={minutes === 30} onClick={() => setMinutes(30)}>30-min</Pill>
        </div>
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value.slice(0, 40))}
          placeholder="Label — e.g. Solo Research, Solo Research + Book Project"
          className="neu-inset w-full rounded-2xl px-4 py-2.5 text-[14px] text-ink outline-none transition placeholder:text-ink-faint focus:ring-2 focus:ring-terracotta/25"
        />
      </div>

      <button
        type="button"
        onClick={grant}
        disabled={busy || !label.trim()}
        className="mt-3 flex w-full items-center justify-center gap-2 rounded-full bg-terracotta px-5 py-3 text-sm font-bold text-paper shadow-lift transition active:scale-[0.98] disabled:opacity-60"
      >
        {busy ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2.4} /> Setting up…
          </>
        ) : (
          <>
            <FlaskConical className="h-4 w-4" strokeWidth={2.4} /> Set up weekly {minutes}-min with{' '}
            {instructor === 'ryan' ? 'Ryan' : 'Aaron'}
          </>
        )}
      </button>

      {result?.error && <p className="mt-2.5 text-[13px] font-medium text-terracotta-deep">{result.error}</p>}
      {result?.ok && (
        <p className="mt-2.5 flex items-start gap-1.5 text-[13px] font-medium text-moss">
          <Check className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={2.4} />
          <span>{result.message}</span>
        </p>
      )}
    </Card>
  );
}

export default function StudentHub() {
  const { sheetId } = useParams();
  const pathname = usePathname() || '';
  // /dev/students/<id> → back to /dev/students; full scoring at /dev/scoring/<id>.
  const backHref = pathname.slice(0, pathname.lastIndexOf('/')) || '/developer/students';
  const scoringHref = pathname.replace('/students/', '/scoring/');

  const [hub, setHub] = useState(null); // { name, classYear, major, transcript, agenda } | {error}
  const [scores, setScores] = useState(null); // { sessions, checkins } | {error}
  const [files, setFiles] = useState(null); // { files } | {error}

  useEffect(() => {
    let alive = true;
    const grab = (url, set) =>
      fetch(url)
        .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
        .then(({ ok, d }) => alive && set(ok && !d.error ? d : { error: d.error || 'Load failed' }))
        .catch(() => alive && set({ error: 'Load failed' }));
    grab(`/api/developer/student/${sheetId}`, setHub);
    grab(`/api/developer/studentScores/${sheetId}`, setScores);
    grab(`/api/developer/studentFiles?sheetId=${encodeURIComponent(sheetId)}`, setFiles);
    return () => {
      alive = false;
    };
  }, [sheetId]);

  // Name the browser tab after the student (e.g. "Aarav Jain · Dev Portal") so
  // open per-student tabs are tellable apart.
  useEffect(() => {
    if (hub?.name) document.title = `${hub.name} · Dev Portal`;
  }, [hub?.name]);

  const back = (
    <Link
      href={backHref}
      className="mb-4 inline-flex items-center gap-1 text-[13px] font-semibold text-ink-soft transition-opacity active:opacity-70"
    >
      <ChevronLeft className="h-4 w-4" strokeWidth={2.2} />
      Students
    </Link>
  );

  if (hub?.error) {
    return (
      <div>
        {back}
        <PageHeader eyebrow="Student" title="Hub" />
        <ErrorNote message={hub.error} />
      </div>
    );
  }
  if (!hub) {
    return (
      <div>
        {back}
        <TabSkeleton rows={5} />
      </div>
    );
  }

  const sessions = scores?.sessions || [];
  const latest = sessions.length ? sessions[sessions.length - 1] : null;
  const checkins = [...(scores?.checkins || [])].sort((a, b) => (a.date < b.date ? 1 : -1));
  const lastCheckin = checkins[0] || null;
  const lastAgo = lastCheckin ? daysAgo(lastCheckin.date) : null;

  return (
    <div>
      {back}
      <PageHeader eyebrow={hub.classYear ? `Class of ${hub.classYear}` : 'Student'} title={hub.name}>
        <p className="mt-1.5 text-[13px] font-semibold uppercase tracking-[0.12em] text-terracotta">
          {hub.major || 'Major not set'}
        </p>
      </PageHeader>

      {/* Grant a one-off meeting (bypasses the check-in gate) */}
      <GrantMeetingCard sheetId={sheetId} studentName={hub.name} />

      {/* Set up a standing weekly project meeting (solo research, etc.) */}
      <ProjectMeetingCard sheetId={sheetId} studentName={hub.name} />

      {/* Scores summary */}
      <Card>
        <div className="mb-3 flex items-baseline justify-between gap-2">
          <h2 className="font-display text-lg font-semibold text-ink">Holistic scores</h2>
          <Link
            href={scoringHref}
            className="inline-flex items-center gap-0.5 text-[12px] font-semibold text-terracotta-deep active:opacity-70"
          >
            Full scoring <ChevronRight className="h-3.5 w-3.5" strokeWidth={2.4} />
          </Link>
        </div>
        {scores?.error ? (
          <ErrorNote message={scores.error} />
        ) : !scores ? (
          <TabSkeleton rows={1} />
        ) : !latest ? (
          <EmptyNote>No 📊 Scores tab yet — run the NAS scorer for this student first.</EmptyNote>
        ) : (
          <div className="flex flex-wrap items-center gap-6">
            <Halo
              rings={[{ value: (latest.shown?.overall ?? 0) / 100, className: 'text-terracotta' }]}
              size={92}
              stroke={15}
            >
              <p className="font-display text-2xl font-semibold leading-none text-ink">
                {latest.shown?.overall ?? '—'}
              </p>
            </Halo>
            <div className="flex flex-col gap-1.5">
              {SUBS.map((s) => (
                <div key={s.key} className="flex items-center gap-2 text-[13px]">
                  <span className={`h-1.5 w-4 rounded-full bg-current ${s.cls}`} />
                  <span className="w-24 text-ink-soft">{s.label}</span>
                  <span className="font-semibold text-ink">{latest.shown?.[s.key] ?? '—'}</span>
                </div>
              ))}
              <p className="mt-1 text-[11px] text-ink-faint">as of {fmtDate(latest.date, false)}</p>
            </div>
          </div>
        )}
      </Card>

      {/* Check-in cadence */}
      <Card className="mt-5" delay={120}>
        <h2 className="mb-3 font-display text-lg font-semibold text-ink">Check-ins</h2>
        {scores?.error ? (
          <ErrorNote message={scores.error} />
        ) : !scores ? (
          <TabSkeleton rows={1} />
        ) : !lastCheckin ? (
          <EmptyNote>No check-ins on file.</EmptyNote>
        ) : (
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-display text-[15px] font-semibold text-ink">
                Last check-in {fmtDate(lastCheckin.date)}
              </span>
              {lastAgo != null && (
                <Badge tone={lastAgo > 9 ? 'ochre' : 'moss'}>
                  {lastAgo === 0 ? 'today' : `${lastAgo}d ago`}
                </Badge>
              )}
              {lastCheckin.who && <span className="text-[12px] text-ink-faint">· {lastCheckin.who}</span>}
            </div>
            <p className="mt-1.5 text-[12px] text-ink-soft">{checkins.length} check-ins on file</p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {checkins.slice(0, 12).map((c, i) => (
                <span
                  key={i}
                  className="neu-chip rounded-full px-2.5 py-1 text-[11px] font-medium text-ink-soft"
                  title={c.who || ''}
                >
                  {fmtDate(c.date, false)}
                </span>
              ))}
            </div>
          </div>
        )}
      </Card>

      {/* Files */}
      <Card className="mt-5" delay={160}>
        <h2 className="mb-3 flex items-center gap-2 font-display text-lg font-semibold text-ink">
          <FileText className="h-5 w-5 text-terracotta" strokeWidth={2} /> Files
        </h2>
        {files?.error ? (
          <ErrorNote message={files.error} />
        ) : !files ? (
          <TabSkeleton rows={2} />
        ) : (files.files || []).length === 0 ? (
          <EmptyNote>No files in this student’s Drive folder.</EmptyNote>
        ) : (
          <div className="space-y-2">
            {files.files.map((f) => {
              const essay = f.source === 'writing';
              return (
                <a
                  key={f.id}
                  href={f.openUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="neu-raised flex items-center gap-3 rounded-2xl p-3 transition active:scale-[0.99]"
                >
                  <span className="neu-chip flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-terracotta">
                    {essay ? (
                      <FilePen className="h-4.5 w-4.5" strokeWidth={1.9} />
                    ) : (
                      <FileText className="h-4.5 w-4.5" strokeWidth={1.9} />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[14px] font-semibold text-ink">{f.name}</p>
                    <p className="text-[11px] text-ink-faint">
                      {essay
                        ? `Essay${f.tabCount ? ` · ${f.tabCount} tab${f.tabCount === 1 ? '' : 's'}` : ''}`
                        : ''}
                      {essay && f.modified ? ' · ' : ''}
                      {f.modified ? fmtDate(f.modified) : ''}
                    </p>
                  </div>
                  <ExternalLink className="h-4 w-4 shrink-0 text-ink-faint" strokeWidth={2} />
                </a>
              );
            })}
          </div>
        )}
      </Card>

      {/* Meeting agenda (read-only) */}
      <Card className="mt-5" delay={200}>
        <h2 className="mb-3 flex items-center gap-2 font-display text-lg font-semibold text-ink">
          <CalendarDays className="h-5 w-5 text-terracotta" strokeWidth={2} /> Meeting agenda
        </h2>
        {(hub.agenda || []).length === 0 ? (
          <EmptyNote>No agenda mirrored yet — the meetings sync hasn’t run for this student.</EmptyNote>
        ) : (
          <div className="space-y-2.5">
            {hub.agenda.map((m, i) => (
              <div key={i} className="neu-inset rounded-2xl p-3.5">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="font-display text-[14px] font-semibold text-ink">{m.project || 'Meeting'}</p>
                  <span className="shrink-0 text-[11px] font-medium text-ink-faint">
                    {fmtDate(m.date)}
                    {m.teacher ? ` · ${m.teacher}` : ''}
                  </span>
                </div>
                {m.agenda && <p className="mt-1 text-[13px] leading-relaxed text-ink-soft">{m.agenda}</p>}
                {m.homework && (
                  <p className="mt-1.5 text-[12px] text-ink-soft">
                    <span className="font-semibold text-ink">HW: </span>
                    {m.homework}
                    {m.hwStatus ? ` (${m.hwStatus})` : ''}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
        <p className="mt-3 text-[11px] text-ink-faint">Read-only — in-app editing lands in a later update.</p>
      </Card>

      {/* Transcript */}
      <Card className="mt-5" delay={240}>
        <h2 className="mb-2 flex items-center gap-2 font-display text-lg font-semibold text-ink">
          <GraduationCap className="h-5 w-5 text-terracotta" strokeWidth={2} /> Transcript
        </h2>
        {!hub.transcript?.values?.length ? (
          <EmptyNote>No 🎓 Transcript tab found for this student.</EmptyNote>
        ) : (
          <div className="flex items-center gap-2">
            <Badge tone={hub.transcript.recentGrades ? 'moss' : 'ochre'}>
              {hub.transcript.recentGrades ? 'Recent grades on file' : 'Grades may be stale'}
            </Badge>
          </div>
        )}
      </Card>
    </div>
  );
}
