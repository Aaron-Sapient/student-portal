'use client';

import { useState } from 'react';

/* THE DOOR'S FIRST BUTTON: a family saying yes without composing an email.
   ─────────────────────────────────────────────────────────────────────────
   The second button beside it is still a plain `mailto`, and that asymmetry is
   the whole point (Aaron, 2026-09-08). A family with questions wants a compose
   window. A family who has decided wants to be finished, and handing them an
   empty draft to write "yes please" in is a step that loses people who were
   already sold.

   THE ONLY CLIENT COMPONENT ON THIS PAGE besides the clock and the reveal.
   Everything else here is server-rendered, so this is deliberately small: one
   POST, four states, no library, no form.

   WHY THE SENT STATE REPLACES THE BUTTON rather than disabling it. A disabled
   control still reads as the thing to press, and the reader is left wondering
   whether it worked. What replaces it says what happened and what happens next,
   in Ryan's voice, and it names nothing the page did not already promise. */

export default function InterestButton({ slug, label, sentHeading, sentBody, fallbackEmail }) {
  const [state, setState] = useState('idle');

  async function send() {
    if (state === 'sending' || state === 'sent') return;
    setState('sending');
    try {
      const res = await fetch('/api/next/interest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug }),
      });
      setState(res.ok ? 'sent' : 'error');
    } catch {
      setState('error');
    }
  }

  if (state === 'sent') {
    return (
      <p className="interest-sent" role="status">
        <span className="interest-sent-lead">{sentHeading}</span>
        <span className="interest-sent-body">{sentBody}</span>
      </p>
    );
  }

  return (
    <>
      <button type="button" className="cal-add-btn" onClick={send} disabled={state === 'sending'}>
        {state === 'sending' ? 'Sending…' : label}
      </button>
      {/* The failure names the address, because the one thing a family must not
          lose here is the ability to reach Ryan at all. */}
      {state === 'error' && (
        <p className="interest-error" role="alert">
          That did not go through. Please write to{' '}
          <a href={`mailto:${fallbackEmail}`}>{fallbackEmail}</a> and Ryan will pick it up.
        </p>
      )}
    </>
  );
}
