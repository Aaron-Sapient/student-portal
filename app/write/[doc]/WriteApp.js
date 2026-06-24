'use client';

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft,
  Bold,
  Check,
  Command,
  Heading1,
  Heading2,
  History,
  Italic,
  Link2,
  List,
  ListOrdered,
  Loader2,
  Redo2,
  RotateCcw,
  Table,
  TriangleAlert,
  Undo2,
  X,
} from 'lucide-react';
import { DateTime } from 'luxon';
import { ZONE } from '@/app/(portal)/portalUtils';

/* Full-screen, Google-Docs-style word processor for ONE document. The doc id is
   the URL path (/write/<docId>); the active tab is a ?tab=<tabId> slug. Mounts
   the vendored MarkdownTabs widget (public/md-editor) and wires it to
   /api/writing/{doc,save,tab,history}. Read-only when the viewer is a parent. */

let mdePromise = null;
function loadMde() {
  if (typeof window === 'undefined') return Promise.resolve(null);
  if (window.MarkdownTabs) return Promise.resolve(window.MarkdownTabs);
  if (mdePromise) return mdePromise;
  mdePromise = new Promise((resolve) => {
    if (!document.querySelector('link[data-mde]')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = '/md-editor/md-editor.css';
      link.dataset.mde = '1';
      document.head.appendChild(link);
    }
    const done = () => resolve(window.MarkdownTabs);
    const existing = document.querySelector('script[data-mde]');
    if (existing) {
      if (window.MarkdownTabs) done();
      else existing.addEventListener('load', done);
      return;
    }
    const s = document.createElement('script');
    s.src = '/md-editor/md-editor.js';
    s.dataset.mde = '1';
    s.onload = done;
    document.head.appendChild(s);
  });
  return mdePromise;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

// Desktop-only formatting toolbar. The vendored editor exposes a whitelisted
// command API (ed.cmd) plus ed.openPalette() — the same internals its command
// palette uses — for a host to drive; we render the buttons. Mirrors the
// canonical demo's pill (Utils/md-editor/demo.html). [cmd, Icon, label]
const TOOLBAR_GROUPS = [
  [['undo', Undo2, 'Undo'], ['redo', Redo2, 'Redo']],
  [['bold', Bold, 'Bold'], ['italic', Italic, 'Italic']],
  [
    ['h1', Heading1, 'Heading 1'],
    ['h2', Heading2, 'Heading 2'],
    ['bullets', List, 'Bullet list'],
    ['numbers', ListOrdered, 'Numbered list'],
  ],
  [['link', Link2, 'Insert link'], ['table', Table, 'Insert table']],
  [['commands', Command, 'Commands (⌥/)']],
];

export default function WriteApp() {
  const params = useParams();
  const sp = useSearchParams();
  const docId = params?.doc;
  const wantTab = sp.get('tab');

  const [state, setState] = useState({ loading: true, error: null, data: null });
  const [save, setSave] = useState('idle'); // idle | saving | saved | error
  const [history, setHistory] = useState(null);
  const [toolbarReady, setToolbarReady] = useState(false);

  const mountRef = useRef(null);
  const edRef = useRef(null);
  const tabsRef = useRef(null);
  const bodiesRef = useRef({});
  const dataRef = useRef(null);
  const saveTimer = useRef(null);
  const pendingTab = useRef(null);

  const readOnly = state.data ? !state.data.canEdit : false;

  // ── load the document ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!docId) return;
    let alive = true;
    setState({ loading: true, error: null, data: null });
    fetch(`/api/writing/doc?doc=${encodeURIComponent(docId)}`)
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        if (d?.error) return setState({ loading: false, error: d.error, data: null });
        dataRef.current = d;
        bodiesRef.current = { ...(d.bodies || {}) };
        setState({ loading: false, error: null, data: d });
      })
      .catch(() => {
        if (alive) setState({ loading: false, error: 'We couldn’t open this document.', data: null });
      });
    return () => {
      alive = false;
    };
  }, [docId]);

  // The doc name is no longer shown in the chromeless UI, so surface it in the
  // browser tab title as "Student · Doc" — so an admin with several students'
  // essays open can tell the tabs apart. Falls back to just the doc name.
  useEffect(() => {
    const label = state.data?.doc?.label;
    const who = state.data?.student?.name;
    if (label) document.title = who ? `${who} · ${label}` : `${label} · Writing`;
  }, [state.data]);

  // ── saving ───────────────────────────────────────────────────────────────────
  const saveTab = useCallback(
    async (tabId, text) => {
      if (!tabId) return;
      setSave('saving');
      try {
        const r = await fetch('/api/writing/save', {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({ tab_id: tabId, body_markdown: text }),
        });
        if (!r.ok) throw new Error('save failed');
        setSave('saved');
      } catch {
        setSave('error');
      }
    },
    []
  );

  const flushNow = useCallback(
    async (tabId) => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      if (pendingTab.current && (!tabId || pendingTab.current === tabId)) {
        const id = pendingTab.current;
        pendingTab.current = null;
        await saveTab(id, bodiesRef.current[id] ?? '');
      }
    },
    [saveTab]
  );

  const scheduleSave = useCallback(
    (tabId) => {
      pendingTab.current = tabId;
      setSave('saving');
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        saveTimer.current = null;
        pendingTab.current = null;
        saveTab(tabId, bodiesRef.current[tabId] ?? '');
      }, 800);
    },
    [saveTab]
  );

  // keep the URL's ?tab= in sync with the active tab (shareable, Google-Docs style)
  const syncUrl = useCallback((tabId) => {
    if (!tabId || typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    url.searchParams.set('tab', tabId);
    window.history.replaceState(null, '', url.toString());
  }, []);

  // Run a toolbar command against the editor. mousedown+preventDefault on the
  // button keeps the editor's selection intact, so the command applies to it.
  const runCmd = useCallback((c) => {
    const ed = edRef.current;
    if (!ed) return;
    if (c === 'commands') ed.openPalette?.();
    else ed.cmd?.(c);
  }, []);

  // ── mount editor once the doc is loaded ─────────────────────────────────────
  useEffect(() => {
    if (!state.data || !mountRef.current || tabsRef.current) return;
    const ro = readOnly;
    let alive = true;
    loadMde().then((MakeTabs) => {
      if (!alive || !MakeTabs || !mountRef.current || tabsRef.current) return;
      const tabs = dataRef.current.tabs || [];
      const initial = tabs.find((t) => t.id === wantTab)?.id || tabs[0]?.id || null;

      const opts = {
        tabs,
        activeId: initial,
        emptyLabel: ro ? 'Nothing written yet' : 'Add a tab to start',
        loadTab: (id) => bodiesRef.current[id] ?? '',
        onTabInput: (id) => {
          bodiesRef.current[id] = tabsRef.current.getText();
          if (!ro) scheduleSave(id);
        },
        onTabSave: (id) => {
          bodiesRef.current[id] = tabsRef.current.getText();
          if (!ro) {
            pendingTab.current = id;
            flushNow(id);
          }
        },
        onSelect: async (prev, next) => {
          if (prev && !ro) await flushNow(prev);
          syncUrl(next);
        },
      };
      if (!ro) {
        opts.onRename = (id, title) =>
          fetch('/api/writing/tab', {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({ action: 'rename', tab_id: id, title }),
          });
        opts.onAddTab = async () => {
          const r = await fetch('/api/writing/tab', {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({ action: 'create', document_id: docId, title: 'Untitled' }),
          });
          const j = await r.json().catch(() => null);
          if (j?.tab?.id) {
            bodiesRef.current[j.tab.id] = '';
            return { id: j.tab.id, title: j.tab.title };
          }
          return null;
        };
      }

      tabsRef.current = MakeTabs(mountRef.current, opts);
      edRef.current = tabsRef.current.getEditor ? tabsRef.current.getEditor() : null;
      if (ro) {
        const surf = mountRef.current.querySelector('.md-surface');
        if (surf) surf.contentEditable = 'false';
      } else if (edRef.current) {
        setToolbarReady(true);
      }
      if (initial) syncUrl(initial);
    });
    return () => {
      alive = false;
    };
  }, [state.data, readOnly, wantTab, docId, scheduleSave, flushNow, syncUrl]);

  // cleanup
  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (mountRef.current) mountRef.current.innerHTML = '';
      tabsRef.current = null;
      edRef.current = null;
    },
    []
  );

  const openHistory = async () => {
    const tabId = tabsRef.current?.getActiveId();
    if (!tabId) return;
    if (!readOnly) await flushNow(tabId);
    const title =
      (dataRef.current?.tabs || []).find((t) => t.id === tabId)?.title || 'this document';
    setHistory({ tabId, title, items: null });
    try {
      const r = await fetch(`/api/writing/history?tab_id=${encodeURIComponent(tabId)}`);
      const j = await r.json();
      setHistory({ tabId, title, items: j.history || [] });
    } catch {
      setHistory({ tabId, title, items: [] });
    }
  };

  const restore = async (revision) => {
    const tabId = history?.tabId;
    if (!tabId) return;
    setSave('saving');
    try {
      await fetch('/api/writing/history', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ tab_id: tabId, revision }),
      });
      const bodyRes = await fetch(
        `/api/writing/history?tab_id=${encodeURIComponent(tabId)}&revision=${revision}`
      );
      const bj = await bodyRes.json();
      const md = bj.body_markdown ?? '';
      bodiesRef.current[tabId] = md;
      tabsRef.current?.setText(md);
      setSave('saved');
      setHistory(null);
    } catch {
      setSave('error');
    }
  };

  // ── render ───────────────────────────────────────────────────────────────────
  if (state.loading) {
    return (
      <div className="write-zen fixed inset-0 z-10 flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-ink-faint" strokeWidth={2.2} />
      </div>
    );
  }
  if (state.error) {
    return (
      <div className="write-zen fixed inset-0 z-10 flex flex-col items-center justify-center px-6 text-center">
        <TriangleAlert className="h-8 w-8 text-terracotta" strokeWidth={2} />
        <p className="mt-3 font-display text-xl font-semibold text-ink">Couldn’t open this doc</p>
        <p className="mt-1 text-sm text-ink-soft">{state.error}</p>
        <Link
          href="/colleges"
          className="neu-chip mt-6 inline-flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold text-terracotta-deep"
        >
          <ArrowLeft className="h-4 w-4" strokeWidth={2.2} /> Back to Colleges
        </Link>
      </div>
    );
  }

  return (
    <div className="write-zen fixed inset-0 z-10 flex flex-col">
      {/* Desktop-only formatting toolbar — an IN-FLOW centered pill at the top of
          the column. It's a flex item, so it RESERVES its own height and the flex-1
          editor below fills the rest; the toolbar can never overlap the document.
          Hidden on phones, where the editor's own selection palette covers this. */}
      {!readOnly && toolbarReady && (
        <div className="write-toolbar-bar">
          <div className="write-toolbar" role="toolbar" aria-label="Formatting">
            {TOOLBAR_GROUPS.map((group, gi) => (
              <Fragment key={gi}>
                {gi > 0 && <span className="write-tb-sep" aria-hidden="true" />}
                {group.map(([cmd, Icon, label]) => (
                  <button
                    key={cmd}
                    type="button"
                    title={label}
                    aria-label={label}
                    className="write-tb-btn"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      runCmd(cmd);
                    }}
                  >
                    <Icon className="h-[18px] w-[18px]" strokeWidth={2.1} />
                  </button>
                ))}
              </Fragment>
            ))}
          </div>
        </div>
      )}

      {/* The document fills the rest of the column. Because this element is the
          editor root (MarkdownTabs adds .mde-tabs to it), filling the remaining
          space makes the tab drawer + scrim cover it even for a short doc. */}
      <div ref={mountRef} className="mde-host min-h-0 flex-1" />

      {/* Autosave state + version history lived in the (now-removed) strip, so
          they move to one discreet floating control — bottom-right, clear of the
          editor's own top-corner tab/TOC buttons and the iOS home indicator. */}
      <div className="write-tools">
        {!readOnly && <SaveDot status={save} />}
        <button
          onClick={openHistory}
          aria-label="Version history"
          title="Version history"
          className="write-tool-btn"
        >
          <History className="h-[18px] w-[18px]" strokeWidth={2.1} />
        </button>
      </div>

      {history && (
        <HistoryOverlay
          history={history}
          onClose={() => setHistory(null)}
          onRestore={readOnly ? null : restore}
        />
      )}
    </div>
  );
}

function SaveDot({ status }) {
  const map = {
    idle: { icon: Check, label: 'Saved', cls: 'text-ink-faint' },
    saving: { icon: Loader2, label: 'Saving…', cls: 'text-ink-soft', spin: true },
    saved: { icon: Check, label: 'Saved', cls: 'text-moss' },
    error: { icon: TriangleAlert, label: 'Retry', cls: 'text-terracotta' },
  };
  const s = map[status] || map.idle;
  const Icon = s.icon;
  return (
    <span className={`flex items-center gap-1.5 text-xs font-semibold ${s.cls}`}>
      <Icon className={`h-3.5 w-3.5 ${s.spin ? 'animate-spin' : ''}`} strokeWidth={2.4} />
      {s.label}
    </span>
  );
}

function HistoryOverlay({ history, onClose, onRestore }) {
  return (
    <div className="write-overlay" onClick={onClose}>
      <div className="write-overlay-card" onClick={(e) => e.stopPropagation()}>
        <HistoryPanel history={history} onClose={onClose} onRestore={onRestore} />
      </div>
    </div>
  );
}

function HistoryPanel({ history, onClose, onRestore }) {
  const items = history.items;
  return (
    <div className="neu-raised rounded-[2rem] p-5">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-ink-faint">
            Version history
          </p>
          <p className="truncate font-display text-base font-semibold text-ink">{history.title}</p>
        </div>
        <button
          onClick={onClose}
          aria-label="Close history"
          className="neu-chip flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-ink-soft active:scale-90"
        >
          <X className="h-4 w-4" strokeWidth={2.2} />
        </button>
      </div>

      {items === null ? (
        <div className="mt-4 space-y-2">
          <div className="portal-skeleton h-12 rounded-2xl" />
          <div className="portal-skeleton h-12 rounded-2xl" />
        </div>
      ) : items.length === 0 ? (
        <p className="mt-4 text-sm text-ink-soft">No saved versions yet.</p>
      ) : (
        <ul className="mt-4 space-y-2.5">
          {items.map((h, i) => {
            const when = h.created_at ? DateTime.fromISO(h.created_at, { zone: ZONE }) : null;
            const isHead = i === 0;
            return (
              <li key={h.revision} className="neu-inset flex items-center gap-3 rounded-2xl px-3.5 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-ink">
                    {h.editor_name || (h.editor_role === 'admin' ? 'Counselor' : 'Student')}
                    {h.source === 'baseline' && (
                      <span className="ml-2 text-xs font-medium text-ink-faint">started</span>
                    )}
                    {h.source === 'restore' && (
                      <span className="ml-2 text-xs font-medium text-ink-faint">restored</span>
                    )}
                  </p>
                  <p className="text-xs text-ink-soft">
                    {when ? when.toRelative() : `revision ${h.revision}`}
                    {isHead && ' · current'}
                  </p>
                </div>
                {onRestore && !isHead && (
                  <button
                    onClick={() => onRestore(h.revision)}
                    className="neu-chip flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold text-terracotta-deep active:scale-95"
                  >
                    <RotateCcw className="h-3.5 w-3.5" strokeWidth={2.2} />
                    Restore
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
