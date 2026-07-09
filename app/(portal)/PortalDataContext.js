'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';

const PortalDataContext = createContext({
  data: null,
  meeting: null,
  meetings: [],
  coach: null,
  loading: true,
  error: null,
  refreshMeetings: () => {},
  refreshHome: () => {},
});

export const usePortalData = () => useContext(PortalDataContext);

// One coordinated fetch for the whole portal shell: both the Home tab and the
// tab bar's status dots read from this, so we hit the network once.
export default function PortalDataProvider({ children }) {
  const [state, setState] = useState({
    data: null,
    meeting: null,
    meetings: [],
    coach: null,
    loading: true,
    error: null,
  });

  // After a cancel/reschedule, every surface showing meetings (Home Today +
  // Meetings subtab) re-syncs from one refetch.
  const refreshMeetings = useCallback(async () => {
    try {
      const res = await fetch('/api/getUpcomingMeetings');
      const data = await res.json();
      const meetings = data?.meetings || [];
      setState((s) => ({ ...s, meetings, meeting: meetings[0] || null }));
    } catch {
      /* keep current list */
    }
  }, []);

  // After a senior check-in, re-pull home-data so `data.senior.checkedIn` (the
  // grant-ledger-backed flag) reflects the new grant immediately, instead of
  // waiting for the next full layout mount.
  const refreshHome = useCallback(async () => {
    try {
      const res = await fetch('/api/home-data');
      const home = await res.json();
      if (home?.error) return;
      setState((s) => ({ ...s, data: home }));
    } catch {
      /* keep current data */
    }
  }, []);

  useEffect(() => {
    let alive = true;
    Promise.all([
      fetch('/api/home-data').then((r) => r.json()),
      fetch('/api/getUpcomingMeetings').then((r) => r.json()).catch(() => ({})),
      fetch('/api/coach').then((r) => r.json()).catch(() => ({})),
    ])
      .then(([home, meetingsRes, coach]) => {
        if (!alive) return;
        if (home?.error) {
          setState((s) => ({ ...s, loading: false, error: home.error }));
        } else {
          const meetings = meetingsRes?.meetings || [];
          setState({
            data: home,
            meeting: meetings[0] || null,
            meetings,
            coach: coach?.coach || null,
            loading: false,
            error: null,
          });
        }
      })
      .catch(() => {
        if (!alive) return;
        setState((s) => ({
          ...s,
          loading: false,
          error: 'We couldn’t load your portal. Try again shortly.',
        }));
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <PortalDataContext.Provider value={{ ...state, refreshMeetings, refreshHome }}>
      {children}
    </PortalDataContext.Provider>
  );
}
