import { GaugeCluster, ScoreReadout } from '@/app/(portal)/homeSections';
import { buildDemo, STUDENT } from './demoData';
import {
  ApplicationCluster,
  CollegeList,
  FileShelf,
  Masthead,
  Meetings,
  Season,
} from './sections';

/* /demo — the family portal as a room sees it.
   ─────────────────────────────────────────────────────────────────────────
   Purpose: a parent, sitting across a table while Ryan talks, should be able to
   tell in one look that their child is being tracked continuously and
   competently. That is the whole job. It follows that:

   · Nothing on this page is operated. No tabs, no dial, no dock, no buttons.
     Every tab's worth of content is on one board at once, because asking the
     presenter to navigate is asking him to stop talking.
   · The board is WIDE, not a centered ribbon. The portal's `max-w-2xl` column
     is a phone layout; on a 1920 screen it is a strip of content with two empty
     thirds beside it. A surface that is scanned, not read, should spend its
     width (frontend-designt → Layout economy).
   · The score CARD is the real product's component, rendered verbatim. The room
     is looking at the actual portal, not a mockup of one.
   · Movement gets more width than the snapshot does. A parent deciding whether
     to spend this money is asking "is my kid moving?", so the check-in-to-
     check-in trajectory sits at 7 columns beside the ring's 5 — inverted from
     the phone, where it is the last thing you scroll to.
   · Lists are hairline rows, not a card each: twelve schools and five sessions
     are the density that makes the tracking legible, and twelve cards would
     cost twelve times the space to say the same twelve things.

   Data: app/demo/demoData.js. Baked, fictional, and reachable by no network
   call of any kind. Only the DATES are computed — as offsets from render time,
   so the board never goes stale in the room. */

/* Rendered per request, NOT prerendered. The board's dates are offsets from
   render time (see demoData.js); as a static export they would freeze at build
   time and the "today" in the masthead would be however old the last deploy is.
   There is no data source behind this, so per-request rendering costs nothing. */
export const dynamic = 'force-dynamic';

export default function DemoPage() {
  const d = buildDemo();

  return (
    <main className="demo-board relative z-10 mx-auto w-full max-w-[1440px] px-8 py-14 xl:px-12">
      <Masthead student={STUDENT} today={d.today} note={d.coachNote} />

      {/* Band 1 — the read. Where she is, and which way she is going. */}
      <div className="board-row mt-10 grid grid-cols-1 gap-6 lg:grid-cols-12">
        <div className="card-hero card-fill lg:col-span-5">
          <GaugeCluster scores={d.scores} />
        </div>
        <div className="lg:col-span-7">
          <ScoreReadout scores={d.scores} />
        </div>
      </div>

      {/* Band 2 — the plan, and the proof that somebody is working it. */}
      <div className="board-row mt-6 grid grid-cols-1 gap-6 lg:grid-cols-12">
        <div className="lg:col-span-7">
          <CollegeList colleges={d.colleges} delay={140} />
        </div>
        <div className="lg:col-span-5">
          <Meetings next={d.nextMeeting} sessions={d.sessions} today={d.today} delay={180} />
        </div>
      </div>

      {/* Band 3 — the paperwork: how far in, where in the calendar, what exists. */}
      <div className="board-row mt-6 grid grid-cols-1 gap-6 lg:grid-cols-12">
        <div className="card-lift card-fill lg:col-span-4">
          <ApplicationCluster application={d.application} delay={220} />
        </div>
        <div className="lg:col-span-3">
          <Season today={d.today} delay={250} />
        </div>
        <div className="lg:col-span-5">
          <FileShelf files={d.files} today={d.today} delay={280} />
        </div>
      </div>

      {/* Honesty marker. Deliberately the quietest thing on the board — the room
          is told it is a sample out loud, so this only has to survive a
          screenshot escaping the room. Delete this one element to remove it. */}
      <p className="mt-10 text-center text-[11px] font-semibold uppercase tracking-[0.2em] text-ink-faint/60">
        Sample portal · fictional student
      </p>
    </main>
  );
}
