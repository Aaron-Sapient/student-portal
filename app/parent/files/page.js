'use client';

import FilesView from '@/app/(portal)/files/FilesView';
import { useParentData } from '../ParentDataContext';

export default function ParentFilesPage() {
  const { activeChild } = useParentData();
  if (!activeChild) return null;

  // Keyed on the child so switching re-runs the fetch with a fresh view.
  return (
    <FilesView
      key={activeChild.sheetId}
      endpoint={`/api/parent/files?student=${activeChild.sheetId}`}
    />
  );
}
