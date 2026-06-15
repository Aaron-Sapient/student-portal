'use client';

import { useState } from 'react';
import { CheckCircle2, CircleAlert, Loader2 } from 'lucide-react';

// The single deliberate action on the approval page: POSTs the signed token to
// /api/checkinDecision (the only place that mutates). Renders the outcome.
export default function ApprovalConfirm({ token, studentName, verb, tone }) {
  const [state, setState] = useState('idle'); // idle | submitting | done | error
  const [result, setResult] = useState(null);
  const first = (studentName || '').split(' ')[0] || 'the student';

  async function confirm() {
    setState('submitting');
    try {
      const res = await fetch('/api/checkinDecision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Something went wrong');
      setResult(data);
      setState('done');
    } catch (e) {
      setResult({ error: e.message });
      setState('error');
    }
  }

  if (state === 'done') {
    const { status, decision, resolvedAs, emailFailed } = result || {};
    let title = 'Done';
    let body = '';
    if (status === 'granted') {
      const len = decision === '30min' ? '30-minute' : '15-minute';
      title = 'Meeting granted';
      body = emailFailed
        ? `Booking unlocked for ${first}, but the notification email couldn’t be sent — they can still book from the portal.`
        : `${first} has been emailed a link to book their ${len} meeting, with parents CC’d.`;
    } else if (status === 'rejected') {
      title = 'Meeting declined';
      body = `No meeting for ${first}. A written report is being generated — no email was sent.`;
    } else if (status === 'booked') {
      title = 'Already booked';
      body = `${first} has already booked this meeting, so it can no longer be changed from here.`;
    } else if (status === 'already') {
      title = 'No change';
      body = `This check-in is already set to “${resolvedAs}”. Nothing to change — pick a different option to revise it.`;
    }
    return (
      <div className="flex flex-col items-center text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl border border-moss/25 bg-moss/[0.08] text-moss">
          <CheckCircle2 className="h-7 w-7" strokeWidth={1.9} />
        </span>
        <h2 className="mt-4 font-display text-xl font-semibold text-ink">{title}</h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-soft">{body}</p>
        <p className="mt-4 text-xs text-ink-faint">You can close this tab.</p>
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div className="space-y-4">
        <div className="flex items-start gap-2 rounded-2xl border border-terracotta/25 bg-clay-50 p-4 text-sm text-terracotta-deep">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={2.2} />
          <span>{result?.error || 'Something went wrong.'}</span>
        </div>
        <button
          type="button"
          onClick={confirm}
          className="w-full rounded-full bg-terracotta px-6 py-3 text-sm font-bold text-paper shadow-lift transition active:scale-[0.98]"
        >
          Try again
        </button>
      </div>
    );
  }

  const isReject = tone === 'reject';
  return (
    <button
      type="button"
      onClick={confirm}
      disabled={state === 'submitting'}
      className={`flex w-full items-center justify-center gap-2 rounded-full px-6 py-3.5 text-sm font-bold shadow-lift transition active:scale-[0.98] disabled:opacity-60 ${
        isReject ? 'neu-chip text-ink-soft' : 'bg-terracotta text-paper'
      }`}
    >
      {state === 'submitting' ? (
        <>
          <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2.4} />
          Working…
        </>
      ) : (
        verb
      )}
    </button>
  );
}
