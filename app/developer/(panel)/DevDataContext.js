'use client';

import { createContext, useCallback, useContext, useRef, useState } from 'react';

// Lazy per-resource cache for the dev portal. Every endpoint is a slow
// Sheets/Calendar read, and a typical session touches one or two tabs — so
// each tab calls ensure(key) on mount (fetch once, no-op afterwards) and
// refresh(key) after a mutation (refetch, keeping stale data visible).

const RESOURCES = {
  blocks: { url: '/api/developer/blocks', pick: (j) => j.blocks || [] },
  meetings: { url: '/api/getUpcomingMeetings?all=true', pick: (j) => j.meetings || [] },
  reports: { url: '/api/developer/writtenReports', pick: (j) => j.reports || [] },
  scoreParams: { url: '/api/developer/score-params', pick: (j) => j },
  studentScores: { url: '/api/developer/studentScores', pick: (j) => j },
  compliance: { url: '/api/developer/checkinCompliance', pick: (j) => j },
  pricing: { url: '/api/developer/pricing', pick: (j) => j.config },
  packageQuotes: { url: '/api/developer/packageQuotes', pick: (j) => j.quotes || [] },
};

const DevDataContext = createContext(null);

export function useDevData() {
  const ctx = useContext(DevDataContext);
  if (!ctx) throw new Error('useDevData must be used within DevDataProvider');
  return ctx;
}

const initialCell = { data: null, loading: false, error: null, loaded: false };

export default function DevDataProvider({ children }) {
  const [cells, setCells] = useState(() =>
    Object.fromEntries(Object.keys(RESOURCES).map((k) => [k, initialCell]))
  );
  const inFlight = useRef(new Set());

  const load = useCallback(async (key) => {
    const res = RESOURCES[key];
    if (!res || inFlight.current.has(key)) return;
    inFlight.current.add(key);
    setCells((s) => ({ ...s, [key]: { ...s[key], loading: true, error: null } }));
    try {
      const r = await fetch(res.url);
      const json = await r.json();
      if (!r.ok || json?.error) throw new Error(json?.error || `HTTP ${r.status}`);
      setCells((s) => ({
        ...s,
        [key]: { data: res.pick(json), loading: false, error: null, loaded: true },
      }));
    } catch (err) {
      setCells((s) => ({
        ...s,
        [key]: { ...s[key], loading: false, error: err.message || 'Failed to load' },
      }));
    } finally {
      inFlight.current.delete(key);
    }
  }, []);

  const ensure = useCallback(
    (key) => {
      const cell = cells[key];
      if (cell && !cell.loaded && !cell.loading && !cell.error) load(key);
    },
    [cells, load]
  );

  const refresh = useCallback((key) => load(key), [load]);

  return (
    <DevDataContext.Provider value={{ ...cells, ensure, refresh }}>
      {children}
    </DevDataContext.Provider>
  );
}
