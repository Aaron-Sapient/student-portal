'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { usePortalData } from './PortalDataContext';
import { hasBookingAvailable, hasCheckinDue } from './portalUtils';
import TabDock from '@/components/portal/TabDock';

// Student tab list + gating/alert logic. The dock mechanics (glass lens,
// viewport handling) live in components/portal/TabDock.
const BASE_TABS = [
  { href: '/dashboard', label: 'Home', sym: 'home' },
  { href: '/check-ins', label: 'Check-Ins', sym: 'fact_check', alert: 'checkin' },
  { href: '/meetings', label: 'Meetings', sym: 'calendar_month', alert: 'book' },
  { href: '/files', label: 'Files', sym: 'folder_open' },
];

// Seniors only — slotted in after Home once we know the student's sheet has a
// college list. Cached in localStorage so returning seniors get the right dock
// on first paint instead of a tab popping in when /api/home-data lands.
const COLLEGES_TAB = { href: '/colleges', label: 'Colleges', sym: 'school' };
const COLLEGES_CACHE_KEY = 'portal:hasColleges';

const subscribeStorage = (cb) => {
  window.addEventListener('storage', cb);
  return () => window.removeEventListener('storage', cb);
};
const readCollegesCache = () => {
  try {
    return localStorage.getItem(COLLEGES_CACHE_KEY) === '1';
  } catch {
    return false;
  }
};
const readCollegesCacheServer = () => false;

export default function PortalTabBar() {
  const { data } = usePortalData();

  // Fresh data decides; until it loads, trust the localStorage cache so a
  // returning senior's dock paints with the right tab count from the start.
  const cachedColleges = useSyncExternalStore(
    subscribeStorage,
    readCollegesCache,
    readCollegesCacheServer
  );
  const showColleges = data ? !!data.hasCollegeList : cachedColleges;
  useEffect(() => {
    if (!data) return;
    try {
      localStorage.setItem(COLLEGES_CACHE_KEY, data.hasCollegeList ? '1' : '0');
    } catch {}
  }, [data]);

  const alerts = {
    checkin: hasCheckinDue(data),
    book: hasBookingAvailable(data),
  };

  const tabs = (showColleges
    ? [BASE_TABS[0], COLLEGES_TAB, ...BASE_TABS.slice(1)]
    : BASE_TABS
  ).map(({ href, label, sym, alert }) => ({
    href,
    label,
    sym,
    showDot: !!(alert && alerts[alert]),
  }));

  return <TabDock tabs={tabs} />;
}
