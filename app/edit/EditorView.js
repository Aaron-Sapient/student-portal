'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  X,
  Eye,
  Code2,
  History,
  Copy,
  Check,
  Save,
  Download,
  CircleAlert,
  RotateCcw,
} from 'lucide-react';

// Inlined here so this client component doesn't import the server (node:fs) lib.
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

function IconButton({ title, onClick, children, disabled }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      className="neu-raised flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-ink-soft transition active:scale-95 disabled:opacity-40"
    >
      {children}
    </button>
  );
}

export default function EditorView() {
  const params = useSearchParams();
  const filename = params.get('file') || '';

  const [view, setView] = useState('preview'); // mobile pane: 'preview' | 'code'
  const [historyOpen, setHistoryOpen] = useState(false);
  const [state, setState] = useState({ loading: true, error: null });
  const [html, setHtml] = useState('');
  const [savedHtml, setSavedHtml] = useState('');
  const [revision, setRevision] = useState(null);
  const [history, setHistory] = useState([]);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef(null);

  const dirty = html !== savedHtml;
  const title = useMemo(() => pretty(filename), [filename]);

  useEffect(() => {
    if (!filename) {
      setState({ loading: false, error: 'No file specified.' });
      return;
    }
    let alive = true;
    fetch(`/api/files/editable?file=${encodeURIComponent(filename)}`)
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (!alive) return;
        if (!ok || d?.error) {
          setState({ loading: false, error: d?.error || 'Could not open this file.' });
          return;
        }
        setHtml(d.html || '');
        setSavedHtml(d.html || '');
        setRevision(d.revision);
        setHistory(d.history || []);
        setState({ loading: false, error: null });
      })
      .catch(() => alive && setState({ loading: false, error: 'Could not open this file.' }));
    return () => {
      alive = false;
    };
  }, [filename]);

  useEffect(() => () => clearTimeout(copyTimer.current), []);

  async function save() {
    if (saving || !dirty) return;
    setSaving(true);
    try {
      const res = await fetch('/api/files/editable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, html, note: note.trim() || null }),
      });
      const d = await res.json();
      if (!res.ok || d?.error) throw new Error(d?.error || 'Save failed');
      setSavedHtml(html);
      setRevision(d.revision);
      setNote('');
      const h = await fetch(
        `/api/files/editable?file=${encodeURIComponent(filename)}`
      ).then((r) => r.json());
      setHistory(h.history || []);
    } catch (e) {
      setState((s) => ({ ...s, error: e.message || 'Save failed' }));
    } finally {
      setSaving(false);
    }
  }

  async function loadRevision(rev) {
    if (dirty && !confirm('Discard your unsaved changes and load this version?')) return;
    try {
      const d = await fetch(
        `/api/files/editable?file=${encodeURIComponent(filename)}&revision=${rev}`
      ).then((r) => r.json());
      if (d?.error) throw new Error(d.error);
      setHtml(d.html || '');
      setHistoryOpen(false);
      setView('code');
    } catch (e) {
      setState((s) => ({ ...s, error: e.message || 'Could not load that version.' }));
    }
  }

  function copySource() {
    navigator.clipboard?.writeText(html).then(() => {
      setCopied(true);
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1600);
    });
  }

  function download() {
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title}.html`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function closeTab() {
    window.close();
    // Browsers may refuse to close a tab they didn't script-open; fall back to
    // the portal so the button always does something.
    setTimeout(() => {
      if (!window.closed) window.location.href = '/files';
    }, 150);
  }

  // ── Render ────────────────────────────────────────────────────────────────
  const frame = 'relative z-10 flex h-[100dvh] flex-col';
  const safeTop = { paddingTop: 'env(safe-area-inset-top)' };

  if (state.loading) {
    return (
      <div className={frame} style={safeTop}>
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="portal-skeleton h-full w-full max-w-5xl rounded-3xl" />
        </div>
      </div>
    );
  }

  if (state.error && !html) {
    return (
      <div className={frame} style={safeTop}>
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <CircleAlert className="h-8 w-8 text-terracotta" strokeWidth={2} />
          <p className="font-display text-lg font-semibold text-ink">Can’t open this</p>
          <p className="max-w-sm text-sm text-ink-soft">{state.error}</p>
          <button
            type="button"
            onClick={() => (window.location.href = '/files')}
            className="neu-raised mt-2 rounded-full px-4 py-2 text-sm font-semibold text-ink-soft"
          >
            Back to Files
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={frame} style={safeTop}>
      {/* Toolbar */}
      <header className="flex items-center gap-2 px-3 py-2.5 sm:gap-2.5 sm:px-4">
        <IconButton title="Close" onClick={closeTab}>
          <X className="h-5 w-5" strokeWidth={2} />
        </IconButton>
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-display text-[1.05rem] font-semibold leading-tight text-ink sm:text-[1.2rem]">
            {title}
          </h1>
          <p className="text-[11px] leading-none text-ink-faint">
            {revision != null ? `Version ${revision}` : ''}
            {dirty ? ' · unsaved changes' : ''}
          </p>
        </div>

        {/* Optional change note — desktop only, keeps the mobile bar uncluttered. */}
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="What changed? (optional)"
          className="neu-inset hidden w-52 rounded-full px-4 py-2 text-[13px] text-ink outline-none placeholder:text-ink-faint lg:block"
        />

        <IconButton title="Version history" onClick={() => setHistoryOpen((v) => !v)}>
          <History className="h-[18px] w-[18px]" strokeWidth={2} />
        </IconButton>
        <IconButton title={copied ? 'Copied' : 'Copy HTML'} onClick={copySource}>
          {copied ? (
            <Check className="h-[18px] w-[18px] text-terracotta" strokeWidth={2.4} />
          ) : (
            <Copy className="h-[18px] w-[18px]" strokeWidth={2} />
          )}
        </IconButton>
        <IconButton title="Download .html" onClick={download}>
          <Download className="h-[18px] w-[18px]" strokeWidth={2} />
        </IconButton>
        <button
          type="button"
          onClick={save}
          disabled={!dirty || saving}
          className={`flex h-10 shrink-0 items-center gap-1.5 rounded-xl px-3.5 text-[13px] font-semibold transition active:scale-[0.98] sm:px-4 ${
            dirty && !saving ? 'bg-terracotta text-white shadow-sm' : 'neu-inset text-ink-faint'
          }`}
        >
          <Save className="h-4 w-4" strokeWidth={2} />
          <span className="hidden sm:inline">{saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}</span>
        </button>
      </header>

      {/* Mobile pane switch (desktop shows both panes side-by-side) */}
      <div className="flex gap-2 px-3 pb-2 lg:hidden">
        {[
          { key: 'preview', label: 'Preview', Icon: Eye },
          { key: 'code', label: 'Code', Icon: Code2 },
        ].map(({ key, label, Icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => setView(key)}
            aria-pressed={view === key}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-2xl px-3 py-2 text-[13px] font-semibold transition active:scale-[0.98] ${
              view === key ? 'neu-inset text-terracotta' : 'neu-raised text-ink-soft'
            }`}
          >
            <Icon className="h-4 w-4" strokeWidth={2} />
            {label}
          </button>
        ))}
      </div>

      {/* Panes */}
      <div className="relative flex min-h-0 flex-1 gap-px overflow-hidden px-2 pb-2 sm:px-3 sm:pb-3 lg:gap-3">
        {/* Code */}
        <section
          className={`min-h-0 flex-col ${
            view === 'code' ? 'flex flex-1' : 'hidden'
          } lg:flex lg:flex-1`}
        >
          <textarea
            value={html}
            onChange={(e) => setHtml(e.target.value)}
            spellCheck={false}
            className="neu-inset h-full w-full resize-none rounded-2xl p-4 font-mono text-[12.5px] leading-relaxed text-ink outline-none"
          />
        </section>

        {/* Preview */}
        <section
          className={`min-h-0 flex-col ${
            view === 'preview' ? 'flex flex-1' : 'hidden'
          } lg:flex lg:flex-1`}
        >
          <div className="neu-inset h-full overflow-hidden rounded-2xl bg-white p-1">
            <iframe
              title="Preview"
              sandbox=""
              srcDoc={html}
              className="h-full w-full rounded-[1rem] bg-white"
            />
          </div>
        </section>

        {/* History drawer */}
        {historyOpen && (
          <>
            <div
              className="absolute inset-0 z-20 bg-ink/20"
              onClick={() => setHistoryOpen(false)}
            />
            <aside className="absolute right-0 top-0 z-30 flex h-full w-full max-w-sm flex-col gap-2 overflow-y-auto rounded-l-3xl bg-cream p-4 shadow-xl">
              <div className="mb-1 flex items-center justify-between">
                <p className="font-display text-lg font-semibold text-ink">Version history</p>
                <IconButton title="Close history" onClick={() => setHistoryOpen(false)}>
                  <X className="h-4 w-4" strokeWidth={2} />
                </IconButton>
              </div>
              {history.length === 0 && (
                <p className="py-6 text-center text-sm text-ink-soft">No versions yet.</p>
              )}
              {history.map((h) => {
                const isBaseline = h.source === 'baseline';
                return (
                  <div
                    key={h.revision}
                    className="neu-raised flex items-center gap-3 rounded-2xl p-3.5"
                  >
                    <span className="neu-chip flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-[11px] font-semibold text-ink-soft">
                      v{h.revision}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-semibold text-ink">
                        {isBaseline ? 'Original (from your counselor)' : h.note || 'Your edit'}
                      </p>
                      <p className="text-[11px] text-ink-faint">{fmtWhen(h.created_at)}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => loadRevision(h.revision)}
                      className="neu-raised flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-semibold text-ink-soft transition active:scale-95"
                    >
                      <RotateCcw className="h-3.5 w-3.5" strokeWidth={2} />
                      Open
                    </button>
                  </div>
                );
              })}
            </aside>
          </>
        )}
      </div>

      {state.error && html && (
        <p className="px-4 pb-2 text-center text-xs text-terracotta-deep">{state.error}</p>
      )}
    </div>
  );
}
