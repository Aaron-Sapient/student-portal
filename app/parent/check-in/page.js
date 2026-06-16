'use client';

import { useState } from 'react';
import { CircleAlert, CircleCheck, Send } from 'lucide-react';
import { useParentData } from '../ParentDataContext';
import { Eyebrow } from '@/app/(portal)/neu';

// The in-portal parent check-in: same pipeline as the public /parents form
// (urgency analysis → ParentCheckins log → support email), but the email comes
// from the verified session and the student is the validated active child.
export default function ParentCheckInPage() {
  const { activeChild } = useParentData();
  const [concern, setConcern] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState(null);

  if (!activeChild) return null;

  const first = (activeChild.name || '').trim().split(' ')[0] || 'your student';

  async function submit(e) {
    e.preventDefault();
    if (!concern.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/parent/checkin?student=${activeChild.sheetId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ concern: concern.trim() }),
      });
      const payload = await res.json();
      if (!res.ok || payload?.error) {
        throw new Error(payload?.error || 'Something went wrong.');
      }
      setDone(true);
    } catch (err) {
      setError(err.message || 'Something went wrong — please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <div className="portal-rise flex min-h-[55vh] flex-col items-center justify-center text-center">
        <span className="neu-chip flex h-16 w-16 items-center justify-center rounded-3xl text-moss">
          <CircleCheck className="h-7 w-7" strokeWidth={1.8} />
        </span>
        <p className="mt-5 font-display text-xl font-semibold text-ink">
          Thanks for reaching out!
        </p>
        <p className="mt-1.5 max-w-xs text-sm text-ink-soft">
          We’ve received your note about {first} and will follow up with next steps soon.
        </p>
        <button
          onClick={() => {
            setConcern('');
            setDone(false);
          }}
          className="neu-raised mt-6 rounded-full px-5 py-2.5 text-[13px] font-semibold text-terracotta-deep transition-transform active:scale-[0.96]"
        >
          Send another note
        </button>
      </div>
    );
  }

  return (
    <div key={activeChild.sheetId} className="space-y-7">
      <header className="portal-rise" style={{ animationDelay: '0ms' }}>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-ink-faint">
          Parent meeting
        </p>
        <h1 className="mt-1.5 font-display text-[2rem] font-semibold leading-[1.08] tracking-tight text-ink sm:text-[2.6rem] sm:leading-[1.05]">
          How can we help<span className="text-terracotta">?</span>
        </h1>
      </header>

      <form onSubmit={submit} className="space-y-5">
        <section
          className="portal-rise neu-raised rounded-[2rem] p-5"
          style={{ animationDelay: '90ms' }}
        >
          <Eyebrow>About {first}</Eyebrow>
          <p className="mt-2 text-sm leading-relaxed text-ink-soft">
            Share a question or concern — include any <strong>deadlines</strong> so we
            can prioritize. We’ll review it and reach out to schedule a meeting if
            one’s needed.
          </p>
          <textarea
            value={concern}
            onChange={(e) => setConcern(e.target.value)}
            rows={7}
            placeholder="Describe your question or concern"
            className="neu-inset mt-4 w-full resize-none rounded-2xl bg-transparent p-4 text-[15px] leading-relaxed text-ink outline-none placeholder:text-ink-faint"
          />
        </section>

        {error && (
          <div className="portal-rise flex items-start gap-3 rounded-2xl border border-terracotta/25 bg-clay-50 p-4">
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-terracotta" strokeWidth={2} />
            <p className="text-xs leading-relaxed text-ink-soft">{error}</p>
          </div>
        )}

        <div className="portal-rise" style={{ animationDelay: '150ms' }}>
          <button
            type="submit"
            disabled={submitting || !concern.trim()}
            className="neu-raised flex w-full items-center justify-center gap-2 rounded-full py-4 text-[15px] font-semibold text-terracotta-deep transition-all active:scale-[0.98] disabled:opacity-50"
          >
            <Send className="h-4 w-4" strokeWidth={2.1} />
            {submitting ? 'Sending…' : 'Send note'}
          </button>
        </div>
      </form>
    </div>
  );
}
