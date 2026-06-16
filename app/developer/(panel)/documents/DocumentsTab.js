'use client';

import { useEffect, useState } from 'react';
import { FilePen, ChevronRight, CircleAlert, FileClock } from 'lucide-react';

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

export default function DocumentsTab() {
  const [list, setList] = useState({ loading: true, error: null, documents: [] });
  const [selected, setSelected] = useState(null); // { studentSheetId, filename }
  const [detail, setDetail] = useState(null); // { html, revision, history, viewing }

  useEffect(() => {
    let alive = true;
    fetch('/api/developer/documents')
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (!alive) return;
        if (!ok || d?.error) {
          setList({ loading: false, error: d?.error || 'Load failed', documents: [] });
        } else {
          setList({ loading: false, error: null, documents: d.documents || [] });
        }
      })
      .catch(() => alive && setList({ loading: false, error: 'Load failed', documents: [] }));
    return () => {
      alive = false;
    };
  }, []);

  function open(doc) {
    setSelected(doc);
    setDetail({ loading: true });
    loadRevision(doc, null);
  }

  function loadRevision(doc, revision) {
    const qs = new URLSearchParams({ sheet: doc.studentSheetId, file: doc.filename });
    if (revision != null) qs.set('revision', String(revision));
    fetch(`/api/developer/documents?${qs}`)
      .then((r) => r.json())
      .then((d) => {
        if (d?.error) return setDetail({ error: d.error });
        setDetail({
          html: d.html,
          revision: d.revision,
          history: d.history || [],
          viewing: revision,
        });
      })
      .catch(() => setDetail({ error: 'Load failed' }));
  }

  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-ink-faint">
          Student edits
        </p>
        <h1 className="mt-1 font-display text-[2rem] font-semibold tracking-tight text-ink">
          Editable documents
        </h1>
        <p className="mt-1 text-sm text-ink-soft">
          Every <code className="rounded bg-ink-faint/10 px-1">_EXTERNAL_EDITABLE</code> file a
          student has changed. The original stays untouched in Drive — these are their saved
          versions.
        </p>
      </header>

      <div className="grid gap-6 md:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
        {/* List */}
        <section className="space-y-3">
          {list.loading && <div className="portal-skeleton h-40 rounded-3xl" />}
          {list.error && (
            <div className="rounded-3xl border border-terracotta/25 bg-clay-50 p-5 text-center">
              <CircleAlert className="mx-auto h-6 w-6 text-terracotta" strokeWidth={2} />
              <p className="mt-2 text-sm text-ink-soft">{list.error}</p>
            </div>
          )}
          {!list.loading && !list.error && list.documents.length === 0 && (
            <div className="neu-inset rounded-3xl p-6 text-center text-sm text-ink-soft">
              No student edits yet.
            </div>
          )}
          {list.documents.map((doc) => {
            const active =
              selected?.studentSheetId === doc.studentSheetId &&
              selected?.filename === doc.filename;
            return (
              <button
                key={`${doc.studentSheetId} ${doc.filename}`}
                type="button"
                onClick={() => open(doc)}
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
                    {doc.studentEmail || doc.studentSheetId} · {doc.edits} edit
                    {doc.edits === 1 ? '' : 's'} · {fmtWhen(doc.updatedAt)}
                  </p>
                </div>
                <span className="neu-chip shrink-0 rounded-full px-2.5 py-1 text-[10px] font-semibold text-ink-soft">
                  v{doc.latestRevision}
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 text-ink-faint" strokeWidth={2} />
              </button>
            );
          })}
        </section>

        {/* Detail */}
        <section className="space-y-4">
          {!selected && (
            <div className="neu-inset flex min-h-[40vh] flex-col items-center justify-center rounded-3xl text-center">
              <FileClock className="h-7 w-7 text-ink-faint" strokeWidth={1.8} />
              <p className="mt-3 text-sm text-ink-soft">Select a document to view it.</p>
            </div>
          )}

          {selected && detail?.loading && <div className="portal-skeleton h-[60vh] rounded-3xl" />}
          {selected && detail?.error && (
            <div className="rounded-3xl border border-terracotta/25 bg-clay-50 p-5 text-center text-sm text-ink-soft">
              {detail.error}
            </div>
          )}

          {selected && detail?.html != null && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="mr-auto font-display text-lg font-semibold text-ink">
                  {pretty(selected.filename)}{' '}
                  <span className="text-sm font-normal text-ink-faint">
                    (showing v{detail.viewing ?? detail.revision})
                  </span>
                </h2>
                {detail.history.map((h) => (
                  <button
                    key={h.revision}
                    type="button"
                    onClick={() => loadRevision(selected, h.revision)}
                    className={`rounded-full px-3 py-1.5 text-[11px] font-semibold transition active:scale-95 ${
                      (detail.viewing ?? detail.revision) === h.revision
                        ? 'neu-inset text-terracotta'
                        : 'neu-raised text-ink-soft'
                    }`}
                    title={
                      h.source === 'baseline'
                        ? 'Original'
                        : h.note || fmtWhen(h.created_at)
                    }
                  >
                    {h.source === 'baseline' ? 'Original' : `v${h.revision}`}
                  </button>
                ))}
              </div>
              <div className="neu-inset overflow-hidden rounded-3xl bg-white p-1">
                <iframe
                  title="Document"
                  sandbox=""
                  srcDoc={detail.html}
                  className="h-[64vh] w-full rounded-[1.25rem] bg-white"
                />
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
