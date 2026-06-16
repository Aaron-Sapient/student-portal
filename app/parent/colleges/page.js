'use client';

import CollegesView from '@/app/(portal)/colleges/CollegesView';
import { useParentData } from '../ParentDataContext';

export default function ParentCollegesPage() {
  const { activeChild } = useParentData();
  if (!activeChild) return null;

  // Keyed on the child so switching re-runs the fetch with a fresh view.
  return (
    <CollegesView
      key={activeChild.sheetId}
      endpoint={`/api/parent/colleges?student=${activeChild.sheetId}`}
    />
  );
}
