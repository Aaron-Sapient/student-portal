'use client';

import { useEffect } from 'react';

/* The one small thing on this page that only a browser can know.
   ─────────────────────────────────────────────────────────────────────────
   It used to live in an inline <script> so it would run before React did.
   That was the wrong trade: the script rewrote the page before hydration,
   React then found markup it had not rendered and regenerated the whole tree
   ("Hydration failed because the server rendered text didn't match"), and the
   dev overlay counted two issues on every load. An effect runs AFTER hydration
   by definition, so nothing here can ever disagree with the server's HTML.

   A LiveClock component was the other half of this file until 2026-09-04. It
   rendered a live two-city sentence above the booking block, and it went with
   the sentence: the chips and the confirm line already carry both clocks. */

/* The ?booked=1 flag a confirmation link may carry. The authoritative booked
   state is the lead's own row, server-rendered, so this is the secondary path:
   it flips one attribute on <html> and CSS does the swap. */
export function BookedFlag() {
  useEffect(() => {
    try {
      const p = new URLSearchParams(window.location.search);
      if (p.get('booked') === '1' || p.get('event_start_time')) {
        document.documentElement.setAttribute('data-booked', '1');
      }
    } catch {}
  }, []);
  return null;
}
