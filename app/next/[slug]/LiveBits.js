'use client';

import { useEffect, useState } from 'react';

/* The two small things on this page that only a browser can know.
   ─────────────────────────────────────────────────────────────────────────
   Both used to live in one inline <script> so they would run before React did.
   That was the wrong trade: the script rewrote the clock's text before
   hydration, React then found text it had not rendered and regenerated the
   whole tree ("Hydration failed because the server rendered text didn't
   match"), and the dev overlay counted two issues on every load. An effect
   runs AFTER hydration by definition, so nothing here can ever disagree with
   the server's HTML; the fallback sentence is on screen until the effect
   fires, which is the same instant the rest of the page becomes tappable. */

/* The clock is computed from the two zone names via Intl, never from a typed
   offset, so it stays right through a daylight-saving change. Each side names
   its own DAY rather than describing the other one: "5:12 pm Friday in Irvine"
   is a fact the reader can act on, where "5:12 pm yesterday" makes them work
   out whose yesterday it is, in the one sentence on the page whose entire job
   is to stop them doing time-zone arithmetic. */
function part(zone, now) {
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
    .format(now)
    .toLowerCase()
    .replace(/\s/g, ' ');
  const day = new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'long' }).format(now);
  return { time, day };
}

export function LiveClock({ fallback, familyZone, familyCity, className }) {
  const [text, setText] = useState(null);

  useEffect(() => {
    function tick() {
      try {
        const now = new Date();
        const fam = part(familyZone, now);
        const pac = part('America/Los_Angeles', now);
        setText(
          `It is ${fam.time} ${fam.day} in ${familyCity} and ${pac.time} ${pac.day} in Irvine.`
        );
      } catch {
        /* An unknown zone name leaves the server's true, dateless sentence. */
      }
    }
    tick();
    /* A page left open in a tab for an hour should not say the wrong hour. */
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [familyZone, familyCity]);

  return <span className={className}>{text || fallback}</span>;
}

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
