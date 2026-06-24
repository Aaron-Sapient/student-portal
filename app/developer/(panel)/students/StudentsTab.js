'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { DateTime } from 'luxon';
import {
  CalendarDays,
  Check,
  ChevronRight,
  ExternalLink,
  FilePen,
  FileText,
  Filter,
  Folder,
  GraduationCap,
  Layers,
  Search,
  Users,
  X,
} from 'lucide-react';
import { PageHeader, Modal, TabSkeleton, ErrorNote, EmptyNote } from '../devUi';

// The unified Students tab: every student as a container card (modeled on the
// AP Dashboard social row) — class year · name · intended major, plus a
// compliance pill + last check-in date, with a folder icon (all their files,
// fuzzy-searchable) and a calendar icon (read-only meeting agenda). Filter by
// class year (a funnel menu), then alphabetical within a year. Shared verbatim by
// /developer/students and /dev/students; the row link and the modals are
// surface-agnostic (admin-gated APIs serve both Aaron and Ryan).

const ZONE = 'America/Los_Angeles';

// Fuzzy rank over a haystack string. Every query token must appear; matches at a
// word boundary rank higher. -1 = no match. Small lists, no dependency.
function rankTokens(hay, query) {
  const h = hay.toLowerCase();
  const tokens = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  let total = 0;
  for (const t of tokens) {
    const idx = h.indexOf(t);
    if (idx === -1) return -1;
    if (idx === 0) total += 3;
    else if (/\s/.test(h[idx - 1])) total += 2;
    else total += 1;
  }
  return total;
}

const rankStudent = (s, q) => rankTokens(`${s.name} ${s.classYear || ''} ${s.grade || ''}`, q);

function fmtDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

// Short month/day (no weekday) for the compact compliance line.
function fmtShort(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return iso;
  }
}

// Compliance from the last check-in date (weekly cadence → a check-in within 7
// days is on track). Computed client-side off the ISO so "Nd ago" stays fresh.
function compliance(lastCheckin) {
  if (!lastCheckin) return { label: 'No check-ins', tone: 'muted', days: null };
  const d = DateTime.fromISO(lastCheckin, { zone: ZONE });
  const days = d.isValid ? Math.floor(DateTime.now().setZone(ZONE).diff(d, 'days').days) : null;
  if (days == null) return { label: 'No check-ins', tone: 'muted', days: null };
  return days <= 7
    ? { label: 'On track', tone: 'moss', days }
    : { label: 'Overdue', tone: 'ochre', days };
}

const TONE = {
  moss: 'bg-moss/[0.14] text-moss',
  ochre: 'bg-ochre/[0.14] text-ochre',
  muted: 'bg-ink-faint/[0.12] text-ink-soft',
};

// ── Folder modal: a student's files (essays + Drive + local), admin-scoped ────
function FilesModal({ student, onClose }) {
  const [state, setState] = useState({ loading: true });
  const [query, setQuery] = useState('');

  useEffect(() => {
    let alive = true;
    fetch(`/api/developer/studentFiles?sheetId=${encodeURIComponent(student.sheetId)}`)
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (!alive) return;
        setState(ok && !d.error ? { files: d.files || [], drive: d.drive } : { error: d.error || 'Load failed' });
      })
      .catch(() => alive && setState({ error: 'Load failed' }));
    return () => {
      alive = false;
    };
  }, [student.sheetId]);

  const shown = useMemo(() => {
    const q = query.trim();
    const files = state.files || [];
    if (!q) return files;
    return files
      .map((f) => ({ f, score: rankTokens(f.name, q) }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.f);
  }, [query, state.files]);

  return (
    <Modal onClose={onClose}>
      <div className="mb-3 flex items-center gap-2">
        <Folder className="h-5 w-5 text-terracotta" strokeWidth={2} />
        <h3 className="font-display text-lg font-semibold text-ink">{student.name}’s files</h3>
        <button onClick={onClose} className="ml-auto text-ink-faint active:scale-90" aria-label="Close">
          <X className="h-5 w-5" strokeWidth={2.2} />
        </button>
      </div>

      {/* Fuzzy search by file name */}
      {state.files && state.files.length > 0 && (
        <div className="neu-inset mb-3 flex items-center gap-2 rounded-full px-4 py-2">
          <Search className="h-4 w-4 shrink-0 text-ink-faint" strokeWidth={2.2} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
            placeholder="Search files by name"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-faint"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="shrink-0 text-ink-faint active:scale-90"
              aria-label="Clear file search"
            >
              <X className="h-4 w-4" strokeWidth={2.2} />
            </button>
          )}
        </div>
      )}

      <div className="max-h-[60vh] space-y-2 overflow-y-auto">
        {state.loading && <TabSkeleton rows={3} />}
        {state.error && <ErrorNote message={state.error} />}
        {state.files && state.files.length === 0 && (
          <EmptyNote>No files found for this student.</EmptyNote>
        )}
        {state.files && state.files.length > 0 && shown.length === 0 && (
          <EmptyNote>No files match “{query.trim()}”.</EmptyNote>
        )}
        {shown.map((f) => (
          <FileRow key={f.id} file={f} />
        ))}
      </div>
    </Modal>
  );
}

// One file row — essays (in-app markdown) get the pen icon and a tab count; Drive
// and local reports get the document icon. Both open in a new tab.
function FileRow({ file: f }) {
  const essay = f.source === 'writing';
  return (
    <a
      href={f.openUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="neu-raised flex items-center gap-3 rounded-2xl p-3 transition active:scale-[0.99]"
    >
      <span className="neu-chip flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-terracotta">
        {essay ? <FilePen className="h-4.5 w-4.5" strokeWidth={1.9} /> : <FileText className="h-4.5 w-4.5" strokeWidth={1.9} />}
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
}

// ── Calendar modal: read-only meeting agenda (Supabase mirror) ───────────────
function AgendaModal({ student, onClose }) {
  const [state, setState] = useState({ loading: true });
  useEffect(() => {
    let alive = true;
    fetch(`/api/developer/student/${encodeURIComponent(student.sheetId)}`)
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (!alive) return;
        setState(ok && !d.error ? { agenda: d.agenda || [] } : { error: d.error || 'Load failed' });
      })
      .catch(() => alive && setState({ error: 'Load failed' }));
    return () => {
      alive = false;
    };
  }, [student.sheetId]);

  return (
    <Modal onClose={onClose}>
      <div className="mb-3 flex items-center gap-2">
        <CalendarDays className="h-5 w-5 text-terracotta" strokeWidth={2} />
        <h3 className="font-display text-lg font-semibold text-ink">{student.name}’s agenda</h3>
        <button onClick={onClose} className="ml-auto text-ink-faint active:scale-90" aria-label="Close">
          <X className="h-5 w-5" strokeWidth={2.2} />
        </button>
      </div>
      <div className="max-h-[60vh] space-y-2.5 overflow-y-auto">
        {state.loading && <TabSkeleton rows={3} />}
        {state.error && <ErrorNote message={state.error} />}
        {state.agenda && state.agenda.length === 0 && (
          <EmptyNote>No agenda mirrored yet — the meetings sync hasn’t run for this student.</EmptyNote>
        )}
        {state.agenda &&
          state.agenda.map((m, i) => (
            <div key={i} className="neu-inset rounded-2xl p-3.5">
              <div className="flex items-baseline justify-between gap-2">
                <p className="font-display text-[14px] font-semibold text-ink">
                  {m.project || 'Meeting'}
                </p>
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
      <p className="mt-3 text-[11px] text-ink-faint">Read-only — editing lands in a later update.</p>
    </Modal>
  );
}

// ── Card row ─────────────────────────────────────────────────────────────────
function StudentCard({ student, base, onFiles, onAgenda }) {
  const router = useRouter();
  const go = () => router.push(`${base}/${student.sheetId}`);
  const stop = (fn) => (e) => {
    e.stopPropagation();
    fn();
  };
  const c = compliance(student.lastCheckin);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={go}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && go()}
      className="neu-raised flex cursor-pointer items-center gap-4 rounded-[1.5rem] px-5 py-4 transition active:scale-[0.995]"
    >
      <span className="w-14 shrink-0 font-display text-[15px] font-semibold tabular-nums text-ink-faint">
        {student.classYear || student.grade || '—'}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate font-display text-[1.05rem] font-semibold text-ink">{student.name}</p>
        <p className="truncate text-[11px] font-bold uppercase tracking-[0.12em] text-terracotta">
          {student.major || '—'}
        </p>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase leading-none tracking-[0.08em] ${TONE[c.tone]}`}>
            {c.label}
          </span>
          {student.lastCheckin && (
            <span className="text-[11px] text-ink-faint">
              {fmtShort(student.lastCheckin)}
              {c.days != null && ` · ${c.days === 0 ? 'today' : `${c.days}d ago`}`}
            </span>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={stop(onFiles)}
        className="neu-chip flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-ink-soft transition active:scale-90"
        aria-label={`${student.name}'s files`}
        title="Files"
      >
        <Folder className="h-[18px] w-[18px]" strokeWidth={2} />
      </button>
      <button
        type="button"
        onClick={stop(onAgenda)}
        className="neu-chip flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-ink-soft transition active:scale-90"
        aria-label={`${student.name}'s agenda`}
        title="Meeting agenda"
      >
        <CalendarDays className="h-[18px] w-[18px]" strokeWidth={2} />
      </button>
      <ChevronRight className="h-4 w-4 shrink-0 text-ink-faint" strokeWidth={2.2} />
    </div>
  );
}

// Class-year filter — a funnel pill that opens a single-select popup
// (icon · label · count · check), modeled on the AP Dashboard social filter.
function YearFilter({ years, year, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const options = [
    { key: 'all', label: 'All', count: years.total, Icon: Layers, value: null },
    ...years.list.map((y) => ({
      key: `y${y}`,
      label: `Class of ${y}`,
      count: years.counts.get(y) || 0,
      Icon: GraduationCap,
      value: y,
    })),
    ...(years.hasOther
      ? [{ key: 'other', label: 'Other', count: years.other, Icon: Users, value: 'other' }]
      : []),
  ];

  const triggerLabel = year == null ? 'All' : year === 'other' ? 'Other' : String(year);
  const triggerCount = (options.find((o) => o.value === year) || options[0]).count;

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="neu-raised flex items-center gap-2.5 rounded-full py-2 pl-4 pr-3 text-[13px] font-semibold transition active:scale-[0.97]"
      >
        <Filter className="h-4 w-4 text-ink-faint" strokeWidth={2.2} />
        <span className="text-ink">{triggerLabel}</span>
        <span className="neu-chip rounded-full px-2 py-0.5 text-[11px] font-bold tabular-nums text-ink-soft">
          {triggerCount}
        </span>
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute left-0 top-[calc(100%+0.6rem)] z-40 w-[min(19rem,calc(100vw-2.5rem))] neu-raised rounded-[1.5rem] bg-cream p-2"
        >
          {options.map((o) => {
            const selected = o.value === year;
            return (
              <button
                key={o.key}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition hover:bg-ink-faint/[0.06] active:scale-[0.98]"
              >
                <o.Icon className="h-[18px] w-[18px] shrink-0 text-ink-faint" strokeWidth={2} />
                <span className="min-w-0 flex-1 truncate font-display text-[15px] font-semibold text-ink">
                  {o.label}
                </span>
                <span className="neu-chip shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-bold tabular-nums text-ink-soft">
                  {o.count}
                </span>
                <span
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-lg transition ${
                    selected ? 'bg-terracotta text-paper' : 'neu-inset text-transparent'
                  }`}
                >
                  <Check className="h-4 w-4" strokeWidth={3} />
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function StudentsTab() {
  const base = usePathname() || '/developer/students';
  const [roster, setRoster] = useState({ loading: true, error: null, students: [] });
  const [query, setQuery] = useState('');
  const [year, setYear] = useState(null); // null = all; a number; or 'other'
  const [filesFor, setFilesFor] = useState(null);
  const [agendaFor, setAgendaFor] = useState(null);

  useEffect(() => {
    let alive = true;
    fetch('/api/developer/roster')
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (!alive) return;
        if (!ok || d?.error) setRoster({ loading: false, error: d?.error || 'Load failed', students: [] });
        else setRoster({ loading: false, error: null, students: d.students || [] });
      })
      .catch(() => alive && setRoster({ loading: false, error: 'Load failed', students: [] }));
    return () => {
      alive = false;
    };
  }, []);

  // Class years present (soonest-to-graduate first) with per-year counts for the
  // filter menu; null years collapse into "Other".
  const years = useMemo(() => {
    const counts = new Map();
    let other = 0;
    for (const s of roster.students) {
      if (s.classYear) counts.set(s.classYear, (counts.get(s.classYear) || 0) + 1);
      else other += 1;
    }
    const list = [...counts.keys()].sort((a, b) => a - b);
    return { list, hasOther: other > 0, counts, other, total: roster.students.length };
  }, [roster.students]);

  const searching = query.trim().length > 0;

  const shown = useMemo(() => {
    let list = roster.students;
    if (year != null) {
      list = list.filter((s) => (year === 'other' ? !s.classYear : s.classYear === year));
    }
    if (searching) {
      const q = query.trim();
      return list
        .map((s) => ({ s, score: rankStudent(s, q) }))
        .filter((x) => x.score >= 0)
        .sort((a, b) => b.score - a.score || a.s.name.localeCompare(b.s.name))
        .map((x) => x.s);
    }
    // Default order: by class year (soonest first, nulls last), then name.
    return [...list].sort((a, b) => {
      const ay = a.classYear || Infinity;
      const by = b.classYear || Infinity;
      return ay - by || a.name.localeCompare(b.name);
    });
  }, [roster.students, year, query, searching]);

  // Year section headers only in the flat "All" view (no search, no year filter).
  const grouped = !searching && year == null;

  return (
    <div>
      <PageHeader eyebrow="Roster" title="Students">
        <p className="mt-2 max-w-xl text-[13px] leading-relaxed text-ink-soft">
          Every student as a card — compliance and last check-in at a glance, plus their files and
          meeting agenda. Filter by class year, or search by name.
        </p>
      </PageHeader>

      {/* Search */}
      <div className="neu-inset mb-3 flex items-center gap-2.5 rounded-full px-5 py-2.5">
        <Search className="h-4 w-4 shrink-0 text-ink-faint" strokeWidth={2.2} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          spellCheck={false}
          placeholder={roster.loading ? 'Loading roster…' : 'Search students by name or year (e.g. “2027”)'}
          className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-faint"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery('')}
            className="shrink-0 text-ink-faint active:scale-90"
            aria-label="Clear search"
          >
            <X className="h-4 w-4" strokeWidth={2.2} />
          </button>
        )}
      </div>

      {/* Class-year filter — funnel pill + popup */}
      {(years.list.length > 1 || years.hasOther) && (
        <div className="mb-5">
          <YearFilter years={years} year={year} onChange={setYear} />
        </div>
      )}

      {roster.loading ? (
        <TabSkeleton rows={6} />
      ) : roster.error ? (
        <ErrorNote message={roster.error} />
      ) : shown.length === 0 ? (
        <EmptyNote>{searching ? `No students match “${query.trim()}”.` : 'No students here.'}</EmptyNote>
      ) : (
        <div className="space-y-2.5">
          {shown.map((s, i) => {
            const prev = shown[i - 1];
            const showHeader =
              grouped && (i === 0 || (prev && (prev.classYear || 0) !== (s.classYear || 0)));
            return (
              <div key={s.sheetId}>
                {showHeader && (
                  <p
                    className={`mb-1.5 px-1 text-[11px] font-bold uppercase tracking-[0.14em] text-ink-faint ${
                      i === 0 ? 'mt-0' : 'mt-4'
                    }`}
                  >
                    {s.classYear ? `Class of ${s.classYear}` : 'Other'}
                  </p>
                )}
                <StudentCard
                  student={s}
                  base={base}
                  onFiles={() => setFilesFor(s)}
                  onAgenda={() => setAgendaFor(s)}
                />
              </div>
            );
          })}
        </div>
      )}

      {filesFor && <FilesModal student={filesFor} onClose={() => setFilesFor(null)} />}
      {agendaFor && <AgendaModal student={agendaFor} onClose={() => setAgendaFor(null)} />}
    </div>
  );
}
