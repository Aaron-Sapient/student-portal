'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Check, History, Loader2, RotateCcw, TriangleAlert, X } from 'lucide-react';
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

export default function WriteApp() {
  const params = useParams();
  const sp = useSearchParams();
  const docId = params?.doc;
  const wantTab = sp.get('tab');

  const [state, setState] = useState({ loading: true, error: null, data: null });
  const [save, setSave] = useState('idle'); // idle | saving | saved | error
  const [history, setHistory] = useState(null);

  const mountRef = useRef(null);
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
      if (ro) {
        const surf = mountRef.current.querySelector('.md-surface');
        if (surf) surf.contentEditable = 'false';
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
      <div className="relative z-10 mx-auto w-full max-w-3xl px-5 py-8">
        <div className="portal-skeleton h-12 w-full rounded-full" />
        <div className="portal-skeleton mt-4 h-[70vh] w-full rounded-[2.25rem]" />
      </div>
    );
  }
  if (state.error) {
    return (
      <div className="relative z-10 mx-auto w-full max-w-3xl px-5 py-16 text-center">
        <TriangleAlert className="mx-auto h-8 w-8 text-terracotta" strokeWidth={2} />
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

  const { doc, student } = state.data;

  return (
    <div className="relative z-10 mx-auto flex min-h-[100dvh] w-full max-w-3xl flex-col px-4 pb-10 pt-5 sm:px-6">
      <header className="flex items-center gap-3 pb-4">
        <Link
          href="/colleges"
          aria-label="Back to Colleges"
          className="neu-chip flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-ink-soft active:scale-90"
        >
          <ArrowLeft className="h-4.5 w-4.5" strokeWidth={2.2} />
        </Link>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-semibold uppercase tracking-[0.16em] text-ink-faint">
            {student?.name ? `${student.name} · ` : ''}
            {readOnly ? 'Read-only' : 'Writing'}
          </p>
          <h1 className="truncate font-display text-xl font-semibold leading-tight text-ink">
            {doc.label}
          </h1>
        </div>
        {readOnly ? (
          <span className="shrink-0 text-xs font-semibold text-ink-faint">View only</span>
        ) : (
          <SavePill status={save} onHistory={openHistory} />
        )}
        {readOnly && (
          <button
            onClick={openHistory}
            aria-label="Version history"
            className="neu-chip flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-ink-soft active:scale-90"
          >
            <History className="h-4 w-4" strokeWidth={2.1} />
          </button>
        )}
      </header>

      <div className="neu-raised flex-1 rounded-[2.25rem] p-5 sm:p-7">
        <div ref={mountRef} className="mde-host min-h-[64vh]" />
      </div>

      {history && (
        <div className="mt-4">
          <HistoryPanel
            history={history}
            onClose={() => setHistory(null)}
            onRestore={readOnly ? null : restore}
          />
        </div>
      )}
    </div>
  );
}

function SavePill({ status, onHistory }) {
  const map = {
    idle: { icon: Check, label: 'Saved', cls: 'text-ink-faint' },
    saving: { icon: Loader2, label: 'Saving…', cls: 'text-ink-soft', spin: true },
    saved: { icon: Check, label: 'Saved', cls: 'text-moss' },
    error: { icon: TriangleAlert, label: 'Retry', cls: 'text-terracotta' },
  };
  const s = map[status] || map.idle;
  const Icon = s.icon;
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <span className={`flex items-center gap-1 text-xs font-semibold ${s.cls}`}>
        <Icon className={`h-3.5 w-3.5 ${s.spin ? 'animate-spin' : ''}`} strokeWidth={2.4} />
        {s.label}
      </span>
      <button
        onClick={onHistory}
        aria-label="Version history"
        title="Version history"
        className="neu-chip flex h-10 w-10 items-center justify-center rounded-full text-ink-soft active:scale-90"
      >
        <History className="h-4 w-4" strokeWidth={2.1} />
      </button>
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
