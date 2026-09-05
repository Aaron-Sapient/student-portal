'use client';

import { useEffect } from 'react';

/* Scroll reveal, the Apple way (2026-09-04, Aaron: "I want scroll animations on
   mobile, like how Apple's website works, not just a static endless scroller").
   ─────────────────────────────────────────────────────────────────────────
   What Apple actually does, and what this copies: a block does not animate
   because it exists, it animates because YOU ARRIVED AT IT. Nothing moves that
   the reader did not scroll to. That single rule is the whole difference
   between a page that feels authored and a page wearing animation as a costume,
   and it has three consequences that are easy to get wrong:

   1. WHAT IS ALREADY ON SCREEN NEVER ANIMATES. The greeting is not something
      the family scrolled to; it is what they opened. A first screen that fades
      itself in reads as a slow page, not a considered one. Anything inside the
      first viewport is marked revealed with the transition suppressed, so it is
      simply there.
   2. IT FIRES ONCE. `unobserve` on the way in, so scrolling back up does not
      re-run the page. A block that re-animates every time it crosses the fold
      turns a document into a toy.
   3. IT CANNOT BE THE REASON SOMETHING IS INVISIBLE. The hidden state lives
      behind `html.reveal-armed`, and that class is only ever added by script —
      by the inline arm in layout.js at parse time, before anything paints. No
      JavaScript, an old browser, a thrown exception: the class never lands, the
      hidden rule never matches, and the family reads the whole page. A booking
      page that renders blank because an animation failed is the worst bug this
      file could have, so it is designed to be unreachable rather than handled.

   The observer only has to catch what the arm did not. Reduced motion is
   handled at the arm (the class is never added), which is the honest reading of
   the preference: not a faster animation, no animation, and no hidden state to
   need one. */
export default function Reveal() {
  useEffect(() => {
    const root = document.documentElement;
    /* Not armed means reduced motion, no IntersectionObserver, or the inline
       arm never ran. In every one of those cases the page is fully visible
       already and there is nothing for this to do. */
    if (!root.classList.contains('reveal-armed')) return;

    const nodes = Array.from(document.querySelectorAll('.next-page [data-reveal]'));
    if (!nodes.length) return;

    /* The fold, with a little slack: a block whose top sits a sliver below the
       viewport on load is one the reader will reach in a few pixels of scroll,
       and animating it there reads as a stutter rather than an arrival. */
    const fold = window.innerHeight * 0.92;
    const pending = [];
    for (const el of nodes) {
      if (el.getBoundingClientRect().top < fold) el.classList.add('reveal-now');
      else pending.push(el);
    }
    if (!pending.length) return;

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add('reveal-in');
          io.unobserve(entry.target);
        }
      },
      /* The negative bottom margin is what makes it feel like Apple rather than
         like a lazy-loader: the block starts fading up once it is genuinely
         into the screen, not the instant its first pixel clears the bottom
         edge. (It fades and does not move — the rise was removed 2026-09-04
         for the stutter it caused; see the reveal block in next.css.) */
      { rootMargin: '0px 0px -12% 0px', threshold: 0.01 }
    );

    for (const el of pending) io.observe(el);
    return () => io.disconnect();
  }, []);

  return null;
}
