'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';

// Parent-portal data layer: which child is active (persisted) and that child's
// home payload from /api/parent/home-data. Files/Colleges pages fetch their own
// endpoints keyed on the active child; this context is the single source for
// "who" plus the Home data.

const ACTIVE_CHILD_KEY = 'parent:activeChild';
const collegesCacheKey = (sheetId) => `parent:hasColleges:${sheetId}`;

const ParentDataContext = createContext(null);

export function useParentData() {
  const ctx = useContext(ParentDataContext);
  if (!ctx) throw new Error('useParentData must be used within ParentDataProvider');
  return ctx;
}

export default function ParentDataProvider({ kids, children }) {
  // Resolved on mount (not in the initializer) so SSR and hydration agree;
  // pages render skeletons until the first fetch lands anyway.
  const [activeChildId, setActiveChildId] = useState(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let stored = null;
    try {
      stored = localStorage.getItem(ACTIVE_CHILD_KEY);
    } catch {}
    const valid = kids.find((k) => k.sheetId === stored);
    setActiveChildId(valid ? valid.sheetId : kids[0]?.sheetId ?? null);
  }, [kids]);

  const setActiveChild = useCallback((sheetId) => {
    setActiveChildId(sheetId);
    try {
      localStorage.setItem(ACTIVE_CHILD_KEY, sheetId);
    } catch {}
  }, []);

  useEffect(() => {
    if (!activeChildId) return;
    let alive = true;
    setLoading(true);
    setError(null);
    fetch(`/api/parent/home-data?student=${activeChildId}`)
      .then((r) => r.json())
      .then((payload) => {
        if (!alive) return;
        if (payload?.error) {
          setError(payload.error);
          setData(null);
        } else {
          setData(payload);
          // Per-child colleges cache so the dock paints right on first load.
          try {
            localStorage.setItem(
              collegesCacheKey(activeChildId),
              payload.hasCollegeList ? '1' : '0'
            );
          } catch {}
        }
        setLoading(false);
      })
      .catch(() => {
        if (!alive) return;
        setError("We couldn't load your student's info. Try again shortly.");
        setData(null);
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [activeChildId]);

  const activeChild = kids.find((k) => k.sheetId === activeChildId) ?? null;

  return (
    <ParentDataContext.Provider
      value={{ kids, activeChild, setActiveChild, data, loading, error }}
    >
      {children}
    </ParentDataContext.Provider>
  );
}

export { collegesCacheKey };
