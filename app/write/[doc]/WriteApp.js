'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft,
  Check,
  History,
  Loader2,
  RotateCcw,
  TriangleAlert,
  X,
} from 'lucide-react';
import { DateTime } from 'luxon';
import { ZONE } from '@/app/(portal)/portalUtils';
import * as Y from 'yjs';
import { getBrowserSupabase } from '@/lib/supabaseBrowser';
import { SupabaseYjsProvider } from '@/lib/collab/supabaseYjsProvider';

/* Full-screen, Google-Docs-style word processor for ONE document. The doc id is
   the URL path (/write/<docId>); the active tab is a ?tab=<tabId> slug. Mounts
   the vendored MarkdownTabs widget (public/md-editor) and wires it to
   /api/writing/{doc,save,tab,history}. Read-only when the viewer is a parent. */

let mdePromise = null;
function loadScript(src, attr) {
  return new Promise((resolve) => {
    const existing = document.querySelector(`script[${attr}]`);
    if (existing) {
      if (existing.dataset.loaded) resolve();
      else existing.addEventListener('load', () => resolve());
      return;
    }
    const s = document.createElement('script');
    s.src = src;
    s.setAttribute(attr, '1');
    s.onload = () => {
      s.dataset.loaded = '1';
      resolve();
    };
    document.head.appendChild(s);
  });
}
// Loads the vendored editor AND its opt-in collaboration binding
// (window.MarkdownCollab). Resolves once both globals are live.
function loadMde() {
  if (typeof window === 'undefined') return Promise.resolve(null);
  if (window.MarkdownTabs && window.MarkdownCollab) return Promise.resolve(window.MarkdownTabs);
  if (mdePromise) return mdePromise;
  mdePromise = new Promise((resolve) => {
    if (!document.querySelector('link[data-mde]')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = '/md-editor/md-editor.css';
      link.dataset.mde = '1';
      document.head.appendChild(link);
    }
    Promise.all([
      loadScript('/md-editor/md-editor.js', 'data-mde'),
      loadScript('/md-editor/md-editor-collab.js', 'data-mde-collab'),
    ]).then(() => resolve(window.MarkdownTabs));
  });
  return mdePromise;
}

// Stable per-string color for a cursor/presence chip (deterministic, theme-friendly).
function colorFor(s) {
  let h = 0;
  for (let i = 0; i < String(s).length; i++) h = (h * 31 + String(s).charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 58% 45%)`;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export default function WriteApp() {
  const params = useParams();
  const sp = useSearchParams();
  const docId = params?.doc;
  const wantTab = sp.get('tab');

  const [state, setState] = useState({ loading: true, error: null, data: null });
  const [save, setSave] = useState('idle'); // idle | saving | saved | error
  const [history, setHistory] = useState(null);

  const mountRef = useRef(null);
  const edRef = useRef(null);
  const tabsRef = useRef(null);
  const bodiesRef = useRef({});
  const dataRef = useRef(null);
  const saveTimer = useRef(null);
  const pendingTab = useRef(null);
  const collabRef = useRef(null); // { provider, binding, tabId, onYt } for the active tab
  const userRef = useRef(null); // { id, name, color } — this viewer's cursor/presence identity
  const [peers, setPeers] = useState([]); // other live editors in the active tab

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

  // ── live collaboration (Yjs over Supabase Realtime) ─────────────────────────
  const teardownCollab = useCallback(() => {
    const c = collabRef.current;
    if (!c) return;
    collabRef.current = null;
    try { c.provider?.ytext?.unobserve(c.onYt); } catch {}
    try { c.binding?.destroy?.(); } catch {}
    try { c.provider?.destroy?.(); } catch {}
    setPeers([]);
  }, []);

  // Bind the ACTIVE tab to a shared Y.Doc over Supabase Realtime. Safe no-op when
  // the collab script hasn't loaded, identity isn't resolved, or the browser
  // Supabase key is absent — in every such case the editor just works solo and
  // saves through the normal /api/writing/save path. (Read-only viewers never
  // reach here; setup is only invoked when !readOnly.)
  const setupCollab = useCallback(() => {
    if (typeof window === 'undefined' || !window.MarkdownCollab) return;
    const tabs = tabsRef.current;
    if (!tabs || !userRef.current) return;
    const supabase = getBrowserSupabase();
    if (!supabase) return; // no NEXT_PUBLIC key → solo editing
    const ed = tabs.getEditor?.();
    const tabId = tabs.getActiveId?.();
    if (!ed || !tabId) return;
    teardownCollab();
    if (!window.Y) window.Y = Y; // md-editor-collab.js reads window.Y at bind time
    try {
      const user = userRef.current;
      const provider = new SupabaseYjsProvider(supabase, {
        docId,
        tabId,
        user,
        seedText: () => bodiesRef.current[tabId] ?? '',
      });
      const binding = window.MarkdownCollab(ed, {
        ytext: provider.ytext,
        awareness: provider.awareness,
        user,
      });
      // Keep bodiesRef converged on REMOTE edits too, so a tab-switch flush can
      // never persist text that predates a peer's change (no silent clobber).
      const onYt = () => { bodiesRef.current[tabId] = provider.ytext.toString(); };
      provider.ytext.observe(onYt);
      binding.on?.('peers', (list) => setPeers((list || []).filter((p) => !p.self)));
      provider.start();
      collabRef.current = { provider, binding, tabId, onYt };
    } catch {
      // any failure → stay solo (editor + save still work without collab)
    }
  }, [docId, teardownCollab]);

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
        toolbar: !ro, // engine's own Docs-style bar; read-only viewers never get one
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
          teardownCollab(); // drop the prev tab's shared doc before makeTabs swaps the text
          syncUrl(next);
          // selectTab swaps the editor text synchronously AFTER this await resolves;
          // rebind on the next macrotask so we bind to the new tab's converged Y.Text.
          if (!ro) setTimeout(() => setupCollab(), 0);
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
            return { id: j.tab.id, title: j.tab.title, deletable: j.tab.deletable };
          }
          return null;
        };
        // Delete a tab. The widget confirms first, then calls this; returning
        // false vetoes removal (e.g. the server refused). The server re-checks
        // deletability, so manual/orphaned tabs delete and active-synced don't.
        opts.onDelete = async (id) => {
          // drop any in-flight debounced save for this tab so it can't POST
          // a revision to a row we're deleting.
          if (pendingTab.current === id) {
            pendingTab.current = null;
            if (saveTimer.current) {
              clearTimeout(saveTimer.current);
              saveTimer.current = null;
            }
          }
          let ok = false;
          try {
            const r = await fetch('/api/writing/tab', {
              method: 'POST',
              headers: JSON_HEADERS,
              body: JSON.stringify({ action: 'delete', tab_id: id }),
            });
            ok = r.ok;
          } catch {
            ok = false;
          }
          if (!ok) return false;
          delete bodiesRef.current[id];
          if (dataRef.current?.tabs) {
            dataRef.current.tabs = dataRef.current.tabs.filter((t) => t.id !== id);
          }
          return true;
        };
      }

      tabsRef.current = MakeTabs(mountRef.current, opts);
      edRef.current = tabsRef.current.getEditor ? tabsRef.current.getEditor() : null;
      if (ro) {
        const surf = mountRef.current.querySelector('.md-surface');
        if (surf) surf.contentEditable = 'false';
      } else if (edRef.current) {
        // Identity for this viewer's cursor/presence. The random suffix makes each
        // session a distinct peer + color even for two anonymous link editors (who
        // share the name "Student (via link)") and the shared 'link@portal' email.
        const actor = dataRef.current?.actor || {};
        const base = actor.email && actor.email !== 'link@portal' ? actor.email : 'anon';
        const uid = `${base}:${Math.random().toString(36).slice(2, 8)}`;
        userRef.current = { id: uid, name: actor.name || 'You', color: colorFor(uid) };
        setupCollab();
      }
      if (initial) syncUrl(initial);
    });
    return () => {
      alive = false;
    };
  }, [state.data, readOnly, wantTab, docId, scheduleSave, flushNow, syncUrl, setupCollab, teardownCollab]);

  // cleanup
  useEffect(
    () => () => {
      teardownCollab();
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (mountRef.current) mountRef.current.innerHTML = '';
      tabsRef.current = null;
      edRef.current = null;
    },
    [teardownCollab]
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
      {/* The document fills the column. Because this element is the editor root
          (MarkdownTabs adds .mde-tabs to it), filling the remaining space makes
          the tab drawer + scrim cover it even for a short doc. When editable, the
          engine mounts its own Docs-style formatting bar (opts.toolbar) sticky
          inside the scrolling stage — desktop-only via the .mde-toolbar media
          query in globals.css; phones keep the selection palette + command search. */}
      <div ref={mountRef} className="mde-host min-h-0 flex-1" />

      {/* Autosave state + version history lived in the (now-removed) strip, so
          they move to one discreet floating control — bottom-right, clear of the
          editor's own top-corner tab/TOC buttons and the iOS home indicator. */}
      <div className="write-tools">
        {peers.length > 0 && (
          <div
            className="flex items-center"
            style={{ marginRight: '2px' }}
            aria-label={`${peers.length} other ${peers.length === 1 ? 'person' : 'people'} editing`}
            title={peers.map((p) => p.name).join(', ')}
          >
            {peers.slice(0, 4).map((p, i) => (
              <span
                key={p.id}
                style={{
                  width: '24px',
                  height: '24px',
                  borderRadius: '999px',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: p.color,
                  color: '#fff',
                  fontSize: '11px',
                  fontWeight: 700,
                  border: '2px solid var(--card, #fff)',
                  marginLeft: i === 0 ? 0 : '-7px',
                  boxShadow: '0 1px 2px rgba(0,0,0,.18)',
                }}
              >
                {String(p.name || '?').trim().charAt(0).toUpperCase()}
              </span>
            ))}
          </div>
        )}
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
