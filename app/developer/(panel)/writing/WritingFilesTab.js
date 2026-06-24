'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUpRight,
  ChevronRight,
  CircleAlert,
  FileClock,
  FilePen,
  Search,
  X,
} from 'lucide-react';

// Combined "Writing" surface for /dev and /developer. Fuzzy-search a student by
// name or year, then see BOTH their in-app markdown essays (Common App / UC PIQ
// / Supplements → the full-screen /write editor) and every _EXTERNAL_EDITABLE
// file they've edited (with revision history). Replaces the old paste-a-sheet-id
// Writing launcher and the separate Docs tab. Admin-gated APIs (Aaron + Ryan).

// ── helpers (file-name prettifier + timestamp, ported from the old Docs tab) ──
function pretty(filename) {
  let base = String(filename || '').replace(/\.[^.]+$/, '');
  base = base.replace(/[ _-]*external[ _-]*editable\s*$/i, '');
  base = base.replace(/[ _-]*external\s*$/i, '');
  base = base.replace(/[_]+/g, ' ').trim();
  return base || filename || 'Document';
}

function fmtWhen(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

// Lightweight fuzzy rank over "<name> <grade>". Every query token must appear;
// matches at the start of the string / a word boundary rank higher than mid-word.
// Returns -1 for a non-match. ~40 students, so no search dependency needed.
function rankStudent(student, query) {
  const hay = `${student.name} ${student.grade || ''}`.toLowerCase();
  const tokens = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  let total = 0;
  for (const t of tokens) {
    const idx = hay.indexOf(t);
    if (idx === -1) return -1;
    if (idx === 0) total += 3;
    else if (/\s/.test(hay[idx - 1])) total += 2;
    else total += 1;
  }
  return total;
}

export default function WritingFilesTab() {
  const [roster, setRoster] = useState({ loading: true, error: null, students: [] });
  const [docsList, setDocsList] = useState({ loading: true, error: null, documents: [] });
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(null); // { sheetId, name, grade }

  const [essays, setEssays] = useState(null); // { loading } | { error } | writing map
  const [fileSel, setFileSel] = useState(null); // a documents-list entry
  const [fileDetail, setFileDetail] = useState(null); // { loading|error|html|revision|history|viewing }

  // Roster (for the picker) + the full edited-files list (filtered per student).
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

    fetch('/api/developer/documents')
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (!alive) return;
        if (!ok || d?.error) setDocsList({ loading: false, error: d?.error || 'Load failed', documents: [] });
        else setDocsList({ loading: false, error: null, documents: d.documents || [] });
      })
      .catch(() => alive && setDocsList({ loading: false, error: 'Load failed', documents: [] }));

    return () => {
      alive = false;
    };
  }, []);

  // Load the selected student's essays; reset the file viewer on every switch.
  useEffect(() => {
    setFileSel(null);
    setFileDetail(null);
    if (!selected) {
      setEssays(null);
      return;
    }
    let alive = true;
    setEssays({ loading: true });
    fetch(`/api/writing?student=${encodeURIComponent(selected.sheetId)}`)
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return;
        setEssays(j?.error ? { error: j.error } : j);
      })
      .catch(() => alive && setEssays({ error: 'Failed to load' }));
    return () => {
      alive = false;
    };
  }, [selected]);

  const results = useMemo(() => {
    const q = query.trim();
    if (!q) return [];
    return roster.students
      .map((s) => ({ s, score: rankStudent(s, q) }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score || a.s.name.localeCompare(b.s.name))
      .slice(0, 8)
      .map((x) => x.s);
  }, [query, roster.students]);

  const studentFiles = useMemo(
    () => (selected ? docsList.documents.filter((d) => d.studentSheetId === selected.sheetId) : []),
    [selected, docsList.documents]
  );

  function pickStudent(s) {
    setSelected(s);
    setQuery('');
  }

  function loadRevision(doc, revision) {
    const qs = new URLSearchParams({ sheet: doc.studentSheetId, file: doc.filename });
    if (revision != null) qs.set('revision', String(revision));
    fetch(`/api/developer/documents?${qs}`)
      .then((r) => r.json())
      .then((d) => {
        if (d?.error) return setFileDetail({ error: d.error });
        setFileDetail({ html: d.html, revision: d.revision, history: d.history || [], viewing: revision });
      })
      .catch(() => setFileDetail({ error: 'Load failed' }));
  }

  function openFile(doc) {
    setFileSel(doc);
    setFileDetail({ loading: true });
    loadRevision(doc, null);
  }

  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-ink-faint">
          Word processor
        </p>
        <h1 className="mt-1 font-display text-3xl font-semibold text-ink">Student writing</h1>
        <p className="mt-1 text-sm text-ink-soft">
          Search a student by name or year to open their essays full-screen and review every file
          they’ve edited. Your edits save as “Aaron” in their version history.
        </p>
      </header>

      {/* ── Student picker ──────────────────────────────────────────────── */}
      <div className="relative">
        <div className="neu-inset flex items-center gap-2.5 rounded-full px-5 py-2.5">
          <Search className="h-4 w-4 shrink-0 text-ink-faint" strokeWidth={2.2} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
            placeholder={
              roster.loading ? 'Loading roster…' : 'Search students by name or year (e.g. “12th”)'
            }
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

        {roster.error && <p className="mt-2 text-sm font-medium text-terracotta">{roster.error}</p>}

        {query.trim() && (
          <div className="mt-2 space-y-1.5">
            {results.length === 0 ? (
              <p className="px-2 py-3 text-sm text-ink-soft">No students match “{query.trim()}”.</p>
            ) : (
              results.map((s) => (
                <button
                  key={s.sheetId}
                  type="button"
                  onClick={() => pickStudent(s)}
                  className="neu-raised flex w-full items-center gap-3 rounded-2xl px-4 py-3 text-left transition active:scale-[0.99]"
                >
                  <span className="min-w-0 flex-1 truncate font-display text-[0.95rem] font-semibold text-ink">
                    {s.name}
                  </span>
                  {s.grade && (
                    <span className="neu-chip shrink-0 rounded-full px-2.5 py-1 text-[10px] font-semibold text-ink-soft">
                      {s.grade}
                    </span>
                  )}
                  <ChevronRight className="h-4 w-4 shrink-0 text-ink-faint" strokeWidth={2} />
                </button>
              ))
            )}
          </div>
        )}
      </div>

      {/* ── Empty state ─────────────────────────────────────────────────── */}
      {!selected && !query.trim() && (
        <div className="neu-inset flex min-h-[28vh] flex-col items-center justify-center rounded-3xl text-center">
          <Search className="h-7 w-7 text-ink-faint" strokeWidth={1.8} />
          <p className="mt-3 text-sm text-ink-soft">Search for a student to see their writing.</p>
        </div>
      )}

      {/* ── Selected student ────────────────────────────────────────────── */}
      {selected && (
        <div className="space-y-8">
          <div className="flex items-center gap-3">
            <div className="min-w-0">
              <h2 className="truncate font-display text-2xl font-semibold text-ink">{selected.name}</h2>
              {selected.grade && <p className="text-xs font-medium text-ink-faint">{selected.grade}</p>}
            </div>
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="neu-chip ml-auto shrink-0 rounded-full px-3.5 py-1.5 text-xs font-semibold text-ink-soft active:scale-95"
            >
              Change student
            </button>
          </div>

          {/* Essays (in-app markdown) */}
          <section className="space-y-4">
            <h3 className="text-xs font-semibold uppercase tracking-[0.18em] text-ink-faint">Essays</h3>
            {essays?.loading && <div className="portal-skeleton h-40 rounded-[2rem]" />}
            {essays?.error && <p className="text-sm font-medium text-terracotta">{essays.error}</p>}
            {essays && !essays.loading && !essays.error && !(essays.docs?.length > 0) && (
              <div className="neu-inset rounded-3xl p-6 text-center text-sm text-ink-soft">
                No essays yet for this student.
              </div>
            )}
            {essays?.docs?.length > 0 &&
              essays.docs.map((d) => (
                <article key={d.id} className="neu-raised rounded-[1.75rem] p-5">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <h4 className="font-display text-lg font-semibold text-ink">{d.label}</h4>
                      <p className="text-xs text-ink-soft">
                        {d.tabs.length} tab{d.tabs.length === 1 ? '' : 's'}
                      </p>
                    </div>
                    <a
                      href={`/write/${d.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="neu-chip flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-terracotta-deep active:scale-90"
                      aria-label={`Open ${d.label}`}
                    >
                      <ArrowUpRight className="h-4.5 w-4.5" strokeWidth={2.2} />
                    </a>
                  </div>
                  {d.tabs.length > 1 && (
                    <div className="mt-4 flex flex-wrap gap-2">
                      {d.tabs.map((t) => (
                        <a
                          key={t.id}
                          href={`/write/${d.id}?tab=${t.id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={`neu-chip rounded-full px-3.5 py-1.5 text-xs font-semibold ${
                            t.dim ? 'text-ink-faint' : 'text-ink'
                          } active:scale-95`}
                        >
                          {t.title}
                        </a>
                      ))}
                    </div>
                  )}
                </article>
              ))}
          </section>

          {/* Edited files (_EXTERNAL_EDITABLE) */}
          <section className="space-y-4">
            <h3 className="text-xs font-semibold uppercase tracking-[0.18em] text-ink-faint">
              Edited files
            </h3>
            {docsList.loading && <div className="portal-skeleton h-32 rounded-3xl" />}
            {docsList.error && (
              <div className="rounded-3xl border border-terracotta/25 bg-clay-50 p-5 text-center">
                <CircleAlert className="mx-auto h-6 w-6 text-terracotta" strokeWidth={2} />
                <p className="mt-2 text-sm text-ink-soft">{docsList.error}</p>
              </div>
            )}
            {!docsList.loading && !docsList.error && studentFiles.length === 0 && (
              <div className="neu-inset rounded-3xl p-6 text-center text-sm text-ink-soft">
                No edited files for this student yet.
              </div>
            )}

            {studentFiles.length > 0 && (
              <div className="grid gap-6 md:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
                {/* List */}
                <div className="space-y-3">
                  {studentFiles.map((doc) => {
                    const active =
                      fileSel?.studentSheetId === doc.studentSheetId && fileSel?.filename === doc.filename;
                    return (
                      <button
                        key={`${doc.studentSheetId} ${doc.filename}`}
                        type="button"
                        onClick={() => openFile(doc)}
                        className={`flex w-full items-center gap-3 rounded-2xl p-4 text-left transition active:scale-[0.99] ${
                          active ? 'neu-inset' : 'neu-raised'
                        }`}
                      >
                        <span className="neu-chip flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-terracotta">
                          <FilePen className="h-5 w-5" strokeWidth={1.9} />
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-display text-[0.95rem] font-semibold text-ink">
                            {pretty(doc.filename)}
                          </p>
                          <p className="truncate text-[11px] text-ink-faint">
                            {doc.edits} edit{doc.edits === 1 ? '' : 's'} · {fmtWhen(doc.updatedAt)}
                          </p>
                        </div>
                        <span className="neu-chip shrink-0 rounded-full px-2.5 py-1 text-[10px] font-semibold text-ink-soft">
                          v{doc.latestRevision}
                        </span>
                        <ChevronRight className="h-4 w-4 shrink-0 text-ink-faint" strokeWidth={2} />
                      </button>
                    );
                  })}
                </div>

                {/* Detail */}
                <div className="space-y-4">
                  {!fileSel && (
                    <div className="neu-inset flex min-h-[40vh] flex-col items-center justify-center rounded-3xl text-center">
                      <FileClock className="h-7 w-7 text-ink-faint" strokeWidth={1.8} />
                      <p className="mt-3 text-sm text-ink-soft">Select a file to view it.</p>
                    </div>
                  )}
                  {fileSel && fileDetail?.loading && <div className="portal-skeleton h-[60vh] rounded-3xl" />}
                  {fileSel && fileDetail?.error && (
                    <div className="rounded-3xl border border-terracotta/25 bg-clay-50 p-5 text-center text-sm text-ink-soft">
                      {fileDetail.error}
                    </div>
                  )}
                  {fileSel && fileDetail?.html != null && (
                    <>
                      <div className="flex flex-wrap items-center gap-2">
                        <h4 className="mr-auto font-display text-lg font-semibold text-ink">
                          {pretty(fileSel.filename)}{' '}
                          <span className="text-sm font-normal text-ink-faint">
                            (showing v{fileDetail.viewing ?? fileDetail.revision})
                          </span>
                        </h4>
                        {fileDetail.history.map((h) => (
                          <button
                            key={h.revision}
                            type="button"
                            onClick={() => loadRevision(fileSel, h.revision)}
                            className={`rounded-full px-3 py-1.5 text-[11px] font-semibold transition active:scale-95 ${
                              (fileDetail.viewing ?? fileDetail.revision) === h.revision
                                ? 'neu-inset text-terracotta'
                                : 'neu-raised text-ink-soft'
                            }`}
                            title={h.source === 'baseline' ? 'Original' : h.note || fmtWhen(h.created_at)}
                          >
                            {h.source === 'baseline' ? 'Original' : `v${h.revision}`}
                          </button>
                        ))}
                      </div>
                      <div className="neu-inset overflow-hidden rounded-3xl bg-white p-1">
                        <iframe
                          title="Document"
                          sandbox=""
                          srcDoc={fileDetail.html}
                          className="h-[64vh] w-full rounded-[1.25rem] bg-white"
                        />
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
