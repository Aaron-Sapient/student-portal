/* A bespoke, dated research list built for ONE family (2026-09-08, Aaron).
   ─────────────────────────────────────────────────────────────────────────
   Stella's page promised one of these and then did not carry it: the last line
   of "What happens next" read "Ryan said he would send a one page list of the
   business competitions Stella could enter. He is finishing it and will send
   it." The list had in fact been finished on 2026-08-26 and was sitting in the
   lead folder. A light page has no calendar and no price, so what it has left
   to be is BESPOKE — the deliverable itself is the argument, and a page that
   describes a deliverable instead of carrying it makes the weaker argument
   twice.

   THE ROW SUPPLIES THE ORDER. This component does not sort. Deadlines are not
   the only axis a family reads on — "which of these can she realistically do"
   beats "which is soonest" — so the ordering is an editorial decision that
   belongs with the person who made the shortlist, not in a comparator here.
   Stella's row leads with the three the source document calls best first-timer
   fits, each marked, and runs the rest by date behind them.

   PROVENANCE IS PART OF THE CONTENT, not a footnote. Every date on a list like
   this is a claim about somebody else's website on a particular day, and it
   goes stale silently. `checked` prints as a sentence in the reader's view
   rather than living in a comment, because the family is the one who will be
   acting on a date that may have moved.

   No card per item, no shadow, no tile: nine of anything wrapped in nine
   containers is footprint that scales with the row count and says nothing. A
   hairline between rows carries the same separation, and it is the rule this
   page already uses under the "what happens next" columns. */

export default function Shortlist({ items }) {
  const rows = (items || []).filter((i) => i && i.name);
  if (!rows.length) return null;

  return (
    <ol className="shortlist">
      {rows.map((it) => (
        <li className="shortlist-item" key={it.name}>
          <p className="shortlist-head">
            <span className="shortlist-name">{it.name}</span>
            {/* The mark is a WORD, never a colour or a dot on its own: this is
                the one piece of judgment on the list and it has to survive a
                greyscale print, a colour-blind reader and a screen reader. */}
            {it.pick && <span className="shortlist-tag">Best first fit</span>}
          </p>
          {it.when && <p className="shortlist-when">{it.when}</p>}
          {it.meta && <p className="shortlist-meta">{it.meta}</p>}
        </li>
      ))}
    </ol>
  );
}
