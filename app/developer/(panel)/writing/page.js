'use client';

import { useState } from 'react';
import { ArrowUpRight } from 'lucide-react';

// Aaron-only launcher (the (panel) layout gates to DEVELOPER_EMAIL). Looks up a
// student's writing docs and links into the full-screen /write/<docId> editor
// (new tab) — your edits land as "Aaron" in version history.
const TEST_STUDENT = '1UW-RSqv30c_BUdv9nfm48YVVs7L-UmWKsYn_jXhYt6w';

export default function DevWritingPage() {
  const [draft, setDraft] = useState(TEST_STUDENT);
  const [map, setMap] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  const load = async (sid) => {
    if (!sid) return;
    setLoading(true);
    setErr(null);
    setMap(null);
    try {
      const r = await fetch(`/api/writing?student=${encodeURIComponent(sid)}`);
      const j = await r.json();
      if (j.error) setErr(j.error);
      else setMap(j);
    } catch {
      setErr('Failed to load');
    }
    setLoading(false);
  };

  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-ink-faint">
          Word processor
        </p>
        <h1 className="mt-1 font-display text-3xl font-semibold text-ink">Student writing</h1>
        <p className="mt-1 text-sm text-ink-soft">
          Open a student’s essays full-screen. Your edits save as “Aaron” in their version history.
        </p>
      </header>

      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          load(draft.trim());
        }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          placeholder="student sheet id"
          className="neu-inset min-w-0 flex-1 rounded-full bg-transparent px-5 py-2.5 font-mono text-xs text-ink outline-none placeholder:text-ink-faint"
        />
        <button
          type="submit"
          className="neu-raised shrink-0 rounded-full px-5 py-2.5 text-sm font-semibold text-terracotta-deep active:scale-95"
        >
          Load
        </button>
      </form>

      {loading && <div className="portal-skeleton h-40 rounded-[2rem]" />}
      {err && <p className="text-sm font-medium text-terracotta">{err}</p>}

      {map?.docs?.length > 0 && (
        <div className="space-y-4">
          {map.student?.name && (
            <p className="text-sm font-semibold text-ink">{map.student.name}</p>
          )}
          {map.docs.map((d) => (
            <article key={d.id} className="neu-raised rounded-[1.75rem] p-5">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="font-display text-lg font-semibold text-ink">{d.label}</h3>
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
        </div>
      )}
    </div>
  );
}
