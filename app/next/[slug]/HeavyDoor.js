'use client';

import { useState } from 'react';

/* THE HEAVY PAGE'S DOOR, forked by tier (2026-09-08, Aaron: "the lead should be
   able to have a forked CTA, just like on the light path").
   ─────────────────────────────────────────────────────────────────────────
   WHY THIS CAN NAME A TIER AND THE LIGHT DOOR CANNOT. A light page carries no
   price, so the only honest ask it has is "tell me if you want options". This
   page carries the offer Ryan actually made, at the figure the family's email
   also carries, so pressing "I want VIP" means one specific thing at one
   specific price that is on screen directly above the button. The earlier
   objection to a tier-named button, that it would commit a family to a base
   figure smaller than their real quote, died when the quote came onto the page.

   THE OPTIONS COME FROM THE QUOTE, never from a list written here. Rishaan is
   offered Comprehensive alone and sees one; the other three see two. A family
   can therefore never press a tier Ryan did not extend to them, and nobody has
   to remember to keep a hardcoded fork in step with the builder.

   ULTRA VIP IS AN INQUIRY, NOT A SELECTION. It is by-conversation on every
   family-facing surface (Claude_Services.md 7) and this page deliberately
   prints no figure for it, so its control asks for a conversation rather than
   accepting a price. It is quiet for the same reason.

   ONE STATE FOR THE WHOLE GROUP, which is the difference from the light door's
   single button. If each control owned its own state, a family who pressed VIP
   would read "Sent" beside two buttons that still look pressable, and the
   obvious next move is to press another one. Ryan would get two conflicting
   answers from one household and no way to tell which came second. The group
   is replaced by what happened. */

const ASK_LABEL = 'I have questions';

export default function HeavyDoor({ slug, options, uvip, askHref, fallbackEmail, firstName }) {
  const [state, setState] = useState('idle');
  const [chosen, setChosen] = useState(null);

  async function send(choice, label) {
    if (state === 'sending' || state === 'sent') return;
    setChosen(label);
    setState('sending');
    try {
      const res = await fetch('/api/next/interest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, choice }),
      });
      setState(res.ok ? 'sent' : 'error');
    } catch {
      setState('error');
    }
  }

  if (state === 'sent') {
    /* Names the tier back, because the family has just told us something
       specific and a generic "Sent" would leave them wondering which button
       they actually pressed. */
    return (
      <p className="interest-sent" role="status">
        <span className="interest-sent-lead">
          {chosen === 'Ultra VIP' ? 'Sent to Ryan.' : `${chosen} it is.`}
        </span>
        <span className="interest-sent-body">
          {chosen === 'Ultra VIP'
            ? `He will reach out himself to talk through what Ultra VIP would look like for ${firstName}.`
            : `Ryan has it and will be in touch to get ${firstName} started. Nothing else to do.`}
        </span>
      </p>
    );
  }

  const busy = state === 'sending';

  return (
    <>
      <div className="cal-add door-fork">
        {options.map((o, i) => (
          <button
            key={o.key}
            type="button"
            /* The first option carries the weight. With two tiers the second is
               quiet rather than small: same target, less shout, so a thumb is
               not punished for choosing it and the page is not shouting twice. */
            className={i === 0 ? 'cal-add-btn is-primary' : 'cal-add-btn is-quiet'}
            onClick={() => send(o.key, o.label)}
            disabled={busy}
          >
            {busy && chosen === o.label ? 'Sending…' : `I want ${o.label}`}
          </button>
        ))}
      </div>
      <div className="cal-add door-fork door-fork-secondary">
        {uvip && (
          <button
            type="button"
            className="cal-add-btn is-quiet"
            onClick={() => send('uvip', 'Ultra VIP')}
            disabled={busy}
          >
            {busy && chosen === 'Ultra VIP' ? 'Sending…' : 'Tell me about Ultra VIP'}
          </button>
        )}
        <a className="cal-add-btn is-quiet" href={askHref}>
          {ASK_LABEL}
        </a>
      </div>
      {/* This sentence also lives in InterestButton, which is the light page's
          door, and the two must not drift: they render the same address from
          the same row field and a family cannot tell which component served
          them. "We", not Ryan by name, for the reason given there — the address
          is `interest.to`, and a row may point it at the shared mailbox. */}
      {state === 'error' && (
        <p className="interest-error" role="alert">
          That did not go through. Please write to{' '}
          <a href={`mailto:${fallbackEmail}`}>{fallbackEmail}</a> and we will pick it up.
        </p>
      )}
    </>
  );
}
