'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  FileText,
  FileChartPie,
  FileCode2,
  Image as ImageIcon,
  Table2,
  Presentation,
  Folder,
  File as FileIcon,
  CircleAlert,
  FolderOpen,
  Search,
  X,
  LayoutGrid,
} from 'lucide-react';
import { ClayFolder } from '../neu';

const KIND_ICON = {
  doc: FileText,
  pdf: FileText,
  image: ImageIcon,
  sheet: Table2,
  slides: Presentation,
  folder: Folder,
  file: FileIcon,
};

// A "Report" is one of our exported _EXTERNAL deliverables; everything else is a
// plain "File" in the student's Drive folder. (Server sets isReport; fall back to
// the filename marker just in case.)
function isReportFile(file) {
  return file.isReport ?? /_external/i.test(file.filename || '');
}

// Lightweight fuzzy matcher: an exact substring ranks highest (earlier hit =
// better), otherwise a subsequence match with a bonus for consecutive letters.
// Returns -1 for no match so callers can drop it.
function fuzzyScore(query, text) {
  const q = query.toLowerCase();
  const t = (text || '').toLowerCase();
  const idx = t.indexOf(q);
  if (idx !== -1) return 1000 - idx;
  let qi = 0;
  let score = 0;
  let prev = -2;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += prev === ti - 1 ? 5 : 1;
      prev = ti;
      qi += 1;
    }
  }
  return qi === q.length ? score : -1;
}

function FileRow({ file, delay }) {
  const report = isReportFile(file);
  const editable = !!file.isEditable;
  // Editable docs get a code-file icon (they're editable HTML); reports get the
  // pie-chart file; everything else its kind icon.
  const Icon = editable ? FileCode2 : report ? FileChartPie : KIND_ICON[file.kind] || FileIcon;

  return (
    <a
      href={file.openUrl}
      target="_blank"
      // Editable docs open our own full-screen editor (same origin) — omit the
      // noopener so the editor tab can close itself. External/Drive docs keep it.
      rel={editable ? undefined : 'noopener noreferrer'}
      className="portal-rise group neu-raised flex items-center gap-3.5 rounded-2xl p-4 transition-transform active:scale-[0.99]"
      style={{ animationDelay: `${delay}ms` }}
    >
      <span
        className={`neu-chip flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${
          report && !editable ? 'text-ink-soft' : 'text-terracotta'
        }`}
      >
        <Icon className="h-5 w-5" strokeWidth={1.9} />
      </span>
      <p className="min-w-0 flex-1 truncate font-display text-[0.98rem] font-semibold leading-snug text-ink">
        {file.name}
      </p>
      <span
        className={`inline-flex shrink-0 items-center rounded-full px-2.5 py-1.5 text-[10px] font-semibold uppercase leading-none tracking-[0.1em] ${
          editable
            ? 'bg-terracotta/[0.12] text-terracotta-deep'
            : report
              ? 'bg-ink-faint/[0.12] text-ink-soft'
              : 'bg-terracotta/[0.09] text-terracotta-deep'
        }`}
      >
        {editable ? 'HTML' : report ? 'Report' : 'File'}
      </span>
    </a>
  );
}

// Spotlight-style: the search field sits in a pill with these as circular icon
// buttons beside it. `label` doubles as the accessible name + tooltip.
const FILTERS = [
  { key: 'all', label: 'Show all', Icon: LayoutGrid },
  { key: 'files', label: 'Files only', Icon: FileText },
  { key: 'reports', label: 'Reports only', Icon: FileChartPie },
];

function Skeleton() {
  return (
    <div className="space-y-7">
      <div>
        <div className="portal-skeleton h-3 w-28 rounded-full" />
        <div className="portal-skeleton mt-3 h-11 w-40 rounded-2xl" />
      </div>
      <div className="space-y-3">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="portal-skeleton h-[76px] rounded-2xl" />
        ))}
      </div>
    </div>
  );
}

export default function FilesView({ endpoint = '/api/files' }) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');

  useEffect(() => {
    let alive = true;
    setState({ loading: true, error: null, data: null });
    fetch(endpoint)
      .then((r) => r.json())
      .then((data) => {
        if (!alive) return;
        if (data?.error) setState({ loading: false, error: data.error, data: null });
        else setState({ loading: false, error: null, data });
      })
      .catch(() => {
        if (!alive) return;
        setState({
          loading: false,
          error: 'We couldn’t load your files. Try again shortly.',
          data: null,
        });
      });
    return () => {
      alive = false;
    };
  }, [endpoint]);

  const allFiles = state.data?.files ?? [];
  const q = query.trim();
  // Apply the type filter, then fuzzy-match + rank on the search query.
  const visible = useMemo(() => {
    let rows = allFiles.filter((f) => {
      if (filter === 'files') return !isReportFile(f);
      if (filter === 'reports') return isReportFile(f);
      return true;
    });
    if (q) {
      rows = rows
        .map((f) => ({ f, s: fuzzyScore(q, f.name) }))
        .filter((x) => x.s >= 0)
        .sort((a, b) => b.s - a.s)
        .map((x) => x.f);
    }
    return rows;
  }, [allFiles, filter, q]);

  if (state.loading) return <Skeleton />;

  if (state.error) {
    return (
      <div className="portal-rise mt-10 rounded-3xl border border-terracotta/25 bg-clay-50 p-6 text-center">
        <CircleAlert className="mx-auto h-7 w-7 text-terracotta" strokeWidth={2} />
        <p className="mt-3 font-display text-lg font-semibold text-ink">Something’s off</p>
        <p className="mt-1 text-sm text-ink-soft">{state.error}</p>
      </div>
    );
  }

  const { files = [], drive } = state.data;
  const driveDisabled = drive?.status === 'disabled' || drive?.status === 'no_access';

  return (
    <div className="space-y-7">
      <header className="portal-rise flex items-center gap-4 sm:gap-5" style={{ animationDelay: '0ms' }}>
        <ClayFolder scale={1.25} />
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-ink-faint">
            Your documents
          </p>
          <h1 className="mt-1.5 font-display text-[2rem] font-semibold leading-[1.08] tracking-tight text-ink sm:text-[2.6rem] sm:leading-[1.05]">
            All your<br />{' '}
            <span className="text-terracotta">files.</span>
          </h1>
        </div>
      </header>

      {driveDisabled && (
        <div
          className="portal-rise neu-inset flex items-start gap-3 rounded-2xl p-4"
          style={{ animationDelay: '60ms' }}
        >
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-ink-faint" strokeWidth={2} />
          <p className="text-xs leading-relaxed text-ink-soft">
            Google Drive isn’t connected yet — showing local files only.
          </p>
        </div>
      )}

      {files.length === 0 ? (
        <div className="portal-rise flex min-h-[40vh] flex-col items-center justify-center text-center">
          <span className="neu-chip flex h-16 w-16 items-center justify-center rounded-3xl text-terracotta">
            <FolderOpen className="h-7 w-7" strokeWidth={1.8} />
          </span>
          <p className="mt-5 font-display text-xl font-semibold text-ink">No files yet</p>
          <p className="mt-1.5 max-w-xs text-sm text-ink-soft">
            Plans, schedules, and shared documents will show up here.
          </p>
        </div>
      ) : (
        <>
          {/* Spotlight-style search pill + circular filter buttons */}
          <div className="portal-rise flex items-center gap-2.5" style={{ animationDelay: '60ms' }}>
            <div className="neu-inset flex min-w-0 flex-1 items-center gap-2.5 rounded-full px-4 py-3">
              <Search className="h-4 w-4 shrink-0 text-ink-faint" strokeWidth={2} />
              <input
                type="text"
                inputMode="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search files…"
                className="min-w-0 flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-ink-faint"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  aria-label="Clear search"
                  className="shrink-0 text-ink-faint transition-transform active:scale-90"
                >
                  <X className="h-4 w-4" strokeWidth={2} />
                </button>
              )}
            </div>
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(f.key)}
                aria-pressed={filter === f.key}
                aria-label={f.label}
                title={f.label}
                className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition active:scale-95 ${
                  filter === f.key ? 'neu-inset text-terracotta' : 'neu-raised text-ink-soft'
                }`}
              >
                <f.Icon className="h-[18px] w-[18px]" strokeWidth={2} />
              </button>
            ))}
          </div>

          {visible.length === 0 ? (
            <p className="portal-rise py-10 text-center text-sm text-ink-soft">
              No {filter === 'reports' ? 'reports' : filter === 'files' ? 'files' : 'documents'} match
              {q ? ` “${q}”` : ' that filter'}.
            </p>
          ) : (
            <section className="space-y-3">
              {visible.map((file, i) => (
                <FileRow key={file.id} file={file} delay={100 + i * 50} />
              ))}
            </section>
          )}
        </>
      )}
    </div>
  );
}
