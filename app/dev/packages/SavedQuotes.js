'use client';

import { useEffect } from 'react';
import { DateTime } from 'luxon';
import { useDevData } from '@/app/developer/(panel)/DevDataContext';
import { Badge, Card, EmptyNote, ErrorNote, TabSkeleton } from '@/app/developer/(panel)/devUi';

// Newest-first list of saved proposals (the "save student profile" record).
export default function SavedQuotes() {
  const { packageQuotes, ensure, refresh } = useDevData();
  useEffect(() => ensure('packageQuotes'), [ensure]);

  if (packageQuotes.error) {
    return <ErrorNote message={packageQuotes.error} onRetry={() => refresh('packageQuotes')} />;
  }
  if (!packageQuotes.data) return <TabSkeleton rows={3} />;

  const quotes = packageQuotes.data;
  return (
    <Card delay={60}>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <h2 className="font-display text-lg font-semibold text-ink">Saved proposals</h2>
        <span className="text-[12px] font-medium text-ink-faint">{quotes.length}</span>
      </div>
      {quotes.length === 0 ? (
        <EmptyNote>No saved proposals yet — build one and hit “Save proposal.”</EmptyNote>
      ) : (
        <div>
          {quotes.map((q) => (
            <div
              key={q.id}
              className="flex items-center justify-between gap-3 border-t border-sand py-3 first:border-t-0"
            >
              <div className="min-w-0">
                <p className="truncate text-[14px] font-semibold text-ink">
                  {q.student_name || 'Untitled'}
                </p>
                <p className="mt-0.5 text-[11px] font-medium text-ink-faint">
                  {q.created_at
                    ? DateTime.fromISO(q.created_at).setZone('America/Los_Angeles').toFormat('LLL d, yyyy · h:mm a')
                    : ''}
                  {q.created_by ? ` · ${q.created_by}` : ''}
                </p>
              </div>
              {q.grade && <Badge tone="muted">{q.grade}th</Badge>}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
