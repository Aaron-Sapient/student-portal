'use client';

import { useEffect, useState } from 'react';
import { DateTime } from 'luxon';
import { useDevData } from '@/app/developer/(panel)/DevDataContext';
import {
  Badge,
  Card,
  EmptyNote,
  ErrorNote,
  GhostButton,
  PillButton,
  TabSkeleton,
} from '@/app/developer/(panel)/devUi';

const stamp = (iso) =>
  iso ? DateTime.fromISO(iso).setZone('America/Los_Angeles').toFormat('LLL d, yyyy · h:mm a') : '';

// Plain-text flavour of the stored email, for the clipboard's text/plain slot
// (and for anyone pasting somewhere that strips HTML). The stored markup is
// what lib/packageEmail.toHtml emits — one <div> per block, <br> for newlines,
// a spacer div for blank lines — so unwinding it is a fixed transform rather
// than general HTML parsing.
function htmlToText(html) {
  return String(html || '')
    .replace(/<div style="height:1em">&nbsp;<\/div>/g, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// One saved proposal, opened. The panel shows `email_html` — the record stored
// at save time — NOT a re-render of the selection: buildEmail resolves the
// season, the late-start window and the early-start block against a reference
// date, so re-rendering an August proposal in October quietly moves every
// total. Re-pricing is what "Open in builder" is for, and it says so.
function QuoteDetail({ id, onBack, onOpenInBuilder }) {
  const [state, setState] = useState({ loading: true, error: '', quote: null });
  const [copied, setCopied] = useState(false);
  // Bumped by Retry. The fetch effect keys on it as well as `id`, because a
  // retry re-requests the SAME id — without it the button set loading:true and
  // nothing ever refetched, wedging the panel on a permanent skeleton.
  const [attempt, setAttempt] = useState(0);

  // No reset-to-loading in the effect body: the parent keys this component on
  // the row id, so a different proposal remounts with fresh initial state, and
  // Retry does its own reset in the handler. Setting state synchronously here
  // would just cascade an extra render (react-hooks/set-state-in-effect).
  useEffect(() => {
    let live = true;
    fetch(`/api/developer/packageQuotes/${id}`)
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!live) return;
        if (!res.ok) setState({ loading: false, error: data.error || `Load failed (${res.status})`, quote: null });
        else setState({ loading: false, error: '', quote: data.quote });
      })
      .catch((err) => live && setState({ loading: false, error: err.message, quote: null }));
    return () => {
      live = false;
    };
  }, [id, attempt]);

  const { loading, error, quote } = state;
  const html = quote?.email_html || '';

  const copy = async () => {
    try {
      if (navigator.clipboard && window.ClipboardItem) {
        await navigator.clipboard.write([
          new window.ClipboardItem({
            'text/html': new Blob([html], { type: 'text/html' }),
            'text/plain': new Blob([htmlToText(html)], { type: 'text/plain' }),
          }),
        ]);
      } else {
        await navigator.clipboard.writeText(htmlToText(html));
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch (e) {
      alert('Copy failed: ' + e.message);
    }
  };

  return (
    <Card delay={60}>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <button
            type="button"
            onClick={onBack}
            className="text-[12px] font-semibold text-ink-faint transition-colors hover:text-terracotta-deep"
          >
            ← All saved proposals
          </button>
          <h2 className="mt-1 font-display text-lg font-semibold text-ink">
            {quote?.student_name || 'Saved proposal'}
          </h2>
          {quote && (
            <p className="mt-0.5 text-[11px] font-medium text-ink-faint">
              {stamp(quote.created_at)}
              {quote.created_by ? ` · ${quote.created_by}` : ''}
              {quote.grade ? ` · ${quote.grade}th` : ''}
            </p>
          )}
        </div>
        {quote && (
          <div className="flex flex-wrap items-center gap-2">
            {copied && <span className="text-[12px] font-medium text-moss">Copied.</span>}
            {quote.selection && (
              <GhostButton onClick={() => onOpenInBuilder(quote.selection)}>Open in builder</GhostButton>
            )}
            {html && <PillButton onClick={copy}>Copy for Gmail</PillButton>}
          </div>
        )}
      </div>

      {loading ? (
        <TabSkeleton rows={3} />
      ) : error ? (
        <ErrorNote
          message={error}
          onRetry={() => {
            setState({ loading: true, error: '', quote: null });
            setAttempt((n) => n + 1);
          }}
        />
      ) : !html ? (
        <EmptyNote>
          This record was saved without its email. “Open in builder” rebuilds it from the saved
          selection — at today’s prices and today’s season, not the ones it was saved with.
        </EmptyNote>
      ) : (
        <>
          {/* "as it was saved", never "as it was sent": Save and Copy are
              independent buttons in either order, and the actual send happens
              in Gmail where this app can see nothing. */}
          <p className="mb-2 text-[12px] leading-snug text-ink-faint">
            The proposal as it was saved. “Open in builder” loads the same student back into the
            builder, where it re-prices for today — seasonal bonuses, the discount stack and the
            expiry date all move with the date.
          </p>
          {/* Our own generated markup: lib/packageEmail.toHtml escapes every text
              node before wrapping it, and only admins can write this row. */}
          <div
            className="neu-inset max-h-[34rem] overflow-y-auto rounded-2xl bg-cream p-4 text-ink"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </>
      )}
    </Card>
  );
}

// Newest-first list of saved proposals (the "save student profile" record).
// Each row opens.
export default function SavedQuotes({ onOpenInBuilder }) {
  const { packageQuotes, ensure, refresh } = useDevData();
  const [openId, setOpenId] = useState(null);
  useEffect(() => ensure('packageQuotes'), [ensure]);

  if (openId) {
    return (
      <QuoteDetail
        key={openId}
        id={openId}
        onBack={() => setOpenId(null)}
        onOpenInBuilder={onOpenInBuilder}
      />
    );
  }

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
            <button
              key={q.id}
              type="button"
              onClick={() => setOpenId(q.id)}
              className="group flex w-full items-center justify-between gap-3 border-t border-sand py-3 text-left first:border-t-0 active:scale-[0.995]"
            >
              <div className="min-w-0">
                <p className="truncate text-[14px] font-semibold text-ink transition-colors group-hover:text-terracotta-deep">
                  {q.student_name || 'Untitled'}
                </p>
                <p className="mt-0.5 text-[11px] font-medium text-ink-faint">
                  {stamp(q.created_at)}
                  {q.created_by ? ` · ${q.created_by}` : ''}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {q.grade && <Badge tone="muted">{q.grade}th</Badge>}
                <span aria-hidden className="text-[13px] text-ink-faint transition-colors group-hover:text-terracotta-deep">
                  ›
                </span>
              </div>
            </button>
          ))}
        </div>
      )}
    </Card>
  );
}
