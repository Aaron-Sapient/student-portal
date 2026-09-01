import DemoApp from './DemoApp';
import { buildDemo } from './demoData';

/* /demo — the family portal as a room sees it.
   ─────────────────────────────────────────────────────────────────────────
   Purpose: a parent, sitting across a table while Ryan talks, should be able to
   tell in one look that their child is being tracked continuously and
   competently. The demonstration IS the navigation: Ryan clicks through five
   sections while he talks, so the portal has to behave like software, not like
   a printed sheet. It follows that:

   · A persistent left rail, five destinations, always showing where you are.
     See DemoApp.js for why a rail and not a top bar.
   · Section switching is in-memory state over baked data. Nothing loads,
     nothing can fail, nothing flashes.
   · The board is WIDE, not the portal's centered phone column, which on a 1920
     screen is a strip of content between two empty thirds.
   · The Choice Score card and the movement chart are the REAL product
     components, rendered verbatim. The room is looking at the actual portal.
   · Lists are hairline rows, not a card each: twelve schools and six sessions
     are the density that makes the tracking legible.

   Data: app/demo/demoData.js, baked and fictional, reachable by no network call
   of any kind. Only the DATES are computed, as offsets from render time, so the
   board never goes stale in the room. */

/* Rendered per request, NOT prerendered. As a static export the dates would
   freeze at build time and the masthead would be as old as the last deploy.
   There is no data source behind this, so per-request rendering costs nothing. */
export const dynamic = 'force-dynamic';

/* `?s=<section>` seeds which section opens first. It exists so a screenshot or a
   bookmark can land on one section directly; the rail still drives everything
   after that, with no URL change and therefore no navigation of any kind. */
export default async function DemoPage({ searchParams }) {
  const sp = await searchParams;
  return <DemoApp data={buildDemo()} initial={sp?.s} />;
}
