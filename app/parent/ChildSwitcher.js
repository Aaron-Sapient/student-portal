'use client';

import { useParentData } from './ParentDataContext';

// Segmented pill for parents with more than one student with us. Hidden for
// single-child families. First names only — siblings sharing a first name is
// rare enough that the full name fallback (below) covers it.
export default function ChildSwitcher() {
  const { kids, activeChild, setActiveChild } = useParentData();
  if (kids.length < 2) return null;

  const firstNames = kids.map((k) => (k.name || '').trim().split(' ')[0]);
  const dupes = new Set(firstNames.filter((n, i) => firstNames.indexOf(n) !== i));

  return (
    <div
      role="tablist"
      aria-label="Choose a student"
      className="neu-inset mx-auto mb-7 flex w-full max-w-sm items-center gap-1 rounded-full p-1.5"
    >
      {kids.map((kid, i) => {
        const active = kid.sheetId === activeChild?.sheetId;
        const label = dupes.has(firstNames[i]) ? kid.name : firstNames[i];
        return (
          <button
            key={kid.sheetId}
            role="tab"
            aria-selected={active}
            onClick={() => setActiveChild(kid.sheetId)}
            className={`flex-1 truncate rounded-full px-4 py-2.5 text-[13px] font-semibold transition-all duration-200 ${
              active
                ? 'neu-raised text-terracotta-deep'
                : 'text-ink-faint active:scale-[0.96]'
            }`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
