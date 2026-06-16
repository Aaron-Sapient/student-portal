'use client';

import TabDock from '@/components/portal/TabDock';
import { useParentData, collegesCacheKey } from './ParentDataContext';

// Parent tab list: Home, Colleges (gated per active child, like the student
// portal's seniors-only tab), Files, and Parent Meeting (the parent's own
// request form — labeled to disambiguate from STUDENT check-ins). No student
// check-ins, no bookings — by design.
export default function ParentTabBar() {
  const { activeChild, data } = useParentData();

  let showColleges = false;
  if (data) {
    showColleges = !!data.hasCollegeList;
  } else if (activeChild) {
    try {
      showColleges = localStorage.getItem(collegesCacheKey(activeChild.sheetId)) === '1';
    } catch {}
  }

  const tabs = [
    { href: '/parent/home', label: 'Home', sym: 'home' },
    ...(showColleges
      ? [{ href: '/parent/colleges', label: 'Colleges', sym: 'school' }]
      : []),
    { href: '/parent/files', label: 'Files', sym: 'folder_open' },
    { href: '/parent/check-in', label: 'Parent Meeting', sym: 'event' },
  ];

  return <TabDock tabs={tabs} />;
}
