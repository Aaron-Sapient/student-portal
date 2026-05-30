'use client';

import { createContext, useContext, useEffect, useState } from 'react';

const PortalDataContext = createContext({
  data: null,
  meeting: null,
  coach: null,
  loading: true,
  error: null,
});

export const usePortalData = () => useContext(PortalDataContext);

// One coordinated fetch for the whole portal shell: both the Home tab and the
// tab bar's status dots read from this, so we hit the network once.
export default function PortalDataProvider({ children }) {
  const [state, setState] = useState({
    data: null,
    meeting: null,
    coach: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    let alive = true;
    Promise.all([
      fetch('/api/home-data').then((r) => r.json()),
      fetch('/api/getUpcomingMeetings').then((r) => r.json()).catch(() => ({})),
      fetch('/api/coach').then((r) => r.json()).catch(() => ({})),
    ])
      .then(([home, meetings, coach]) => {
        if (!alive) return;
        if (home?.error) {
          setState({ data: null, meeting: null, coach: null, loading: false, error: home.error });
        } else {
          setState({
            data: home,
            meeting: meetings?.meetings?.[0] || null,
            coach: coach?.coach || null,
            loading: false,
            error: null,
          });
        }
      })
      .catch(() => {
        if (!alive) return;
        setState({
          data: null,
          meeting: null,
          coach: null,
          loading: false,
          error: 'We couldn’t load your portal. Try again shortly.',
        });
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <PortalDataContext.Provider value={state}>{children}</PortalDataContext.Provider>
  );
}
