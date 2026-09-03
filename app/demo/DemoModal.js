'use client';

import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

/* One overlay shell for all three of the demo's interactive surfaces: a document
   reader, the check-in, and the booking flow.

   Why a modal and not a route. The board's whole premise is that nothing loads
   between a click and a render, because Ryan is talking over it and a spinner in
   the middle of a sentence is the demo failing. A modal keeps the section behind
   it mounted, so closing is instant and the board never re-paints.

   Escape closes, the backdrop closes, the page behind is scroll-locked, and
   focus moves into the panel on open and returns to the opener on close. A demo
   run from a keyboard in front of a family should not trap them. */

export default function DemoModal({ open, onClose, title, sub, children, wide = false }) {
  const panelRef = useRef(null);
  const restoreRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;

    restoreRef.current = document.activeElement;
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';

    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    document.addEventListener('keydown', onKey);

    // The panel itself takes focus rather than the first control: a check-in
    // that opens with a slider already grabbed reads as the demo answering for
    // the family.
    panelRef.current?.focus();

    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      const el = restoreRef.current;
      if (el && typeof el.focus === 'function') el.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="demo-modal-root" role="presentation">
      {/* The backdrop is a sibling button, not a click handler on the wrapper,
          so a click inside the panel can never bubble into a close. */}
      <button type="button" className="demo-modal-scrim" aria-label="Close" onClick={onClose} />
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`demo-modal-panel neu-raised ${wide ? 'is-wide' : ''}`}
      >
        <header className="demo-modal-head">
          <div className="min-w-0">
            <h2 className="font-display text-[1.5rem] font-semibold leading-snug text-ink">
              {title}
            </h2>
            {sub && <p className="mt-1 text-[14px] leading-relaxed text-ink-soft">{sub}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="demo-modal-x neu-chip"
          >
            <X className="h-[18px] w-[18px]" strokeWidth={2.2} aria-hidden />
          </button>
        </header>
        <div className="demo-modal-body">{children}</div>
      </div>
    </div>
  );
}
