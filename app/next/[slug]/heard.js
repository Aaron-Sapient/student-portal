import {
  TrainFront,
  Feather,
  DraftingCompass,
  SignpostBig,
  Landmark,
  Route,
  Sparkles,
} from 'lucide-react';

/* "What Ryan heard": the three things about this student, as a strip of modules.
   ─────────────────────────────────────────────────────────────────────────
   Modular the way the superscore results page is modular (2026-08-14, the
   BuzzFeed-sorting architecture): a small library of authored module KINDS,
   each with its own glyph and its own place in the strip, and a lead row that
   names which kinds it uses and fills in the student's specifics. The page
   looks written for one family because the words are theirs; it is built from
   parts because the kinds are ours. A new lead is three lines of JSON.

   The kinds are ordered, and that order was once Ryan's pipeline for a
   solo-project student: an INTEREST is the starting point, the PROJECT is what
   gets built from it, the DESTINATION is where the application goes. It was a
   sequence, so the connectors were arrows.

   THE ARROWHEADS ARE GONE, at both breakpoints (mobile 2026-09-04, desktop the
   same evening: "the arrow is still awkward... kill the terminal point
   entirely on desktop, just like you did on mobile"). The rule they were drawn
   from is the rule that removed them — parallel peers get no arrow — because
   the transcript rewrite replaced the pipeline with three facts about one
   student, and three facts are peers. What is left is a plain rail: it says
   these belong to one set, which is true, and says nothing about order, which
   is no longer ours to claim. A VISITS module is logistics rather than a stage
   and belongs in the international section, not here.

   Icons are Lucide, vendored from lucide-react on its 24px / 2px-stroke grid,
   chosen as ideographs rather than decorations: a train front for trains, a
   quill for poetry, a drafting compass for "a project being built", a
   two-armed signpost for "two destinations, both open". A lead row may name
   its interest's glyph; everything else is fixed per kind, so a family can
   never be shown the wrong idea by a typo in a data file. */

/* Glyphs a ROW may name for itself, whatever its kind. This used to be reachable
   only from an `interest`, which meant a module about a railways research paper
   could not be given the train: the kind's default won, and a drafting compass
   said "a project" where the page had something far more specific to say. A row
   still cannot invent a glyph, only choose from this list, so a typo in a data
   file falls back to the kind's default rather than showing a family nothing. */
const ICONS = {
  train: TrainFront,
  feather: Feather,
  compass: DraftingCompass,
  signpost: SignpostBig,
  route: Route,
};

const KINDS = {
  interest: { Icon: Sparkles },
  project: { Icon: DraftingCompass },
  destination: { Icon: SignpostBig },
  visits: { Icon: Landmark },
  /* What the family is buying, in the student's own words on the call. A route
     rather than a map: a map shows the ground, a route is the line drawn across
     it, which is the thing that does not exist yet. */
  roadmap: { Icon: Route },
};

/* Older rows carry no `kind`. Three items in the original order are the three
   stages, so position is a safe fallback for exactly that shape. */
const BY_POSITION = ['interest', 'project', 'destination'];

function resolve(item, i) {
  const kind = item.kind || BY_POSITION[i] || 'interest';
  const def = KINDS[kind] || KINDS.interest;
  const Icon = ICONS[item.icon] || def.Icon;
  return { ...item, kind, Icon };
}

export default function HeardStrip({ items }) {
  const modules = (items || []).slice(0, 3).map(resolve);
  if (!modules.length) return null;

  return (
    <ol className="heard" aria-label="What Ryan heard">
      {modules.map((m, i) => (
        <li key={m.kind + i} className="heard-item">
          {/* The connector belongs to the boundary between two modules, so it
              is drawn as part of every module after the first. Decorative:
              the list order already says "then". */}
          {i > 0 && <span className="heard-conn" aria-hidden="true" />}
          {/* The tile sits inside a wrapper so that, in the row layout, the rail
              can run from the tile's edge to the next module without a second
              element per module. */}
          <span className="heard-glyph">
            <span className="heard-tile">
              <m.Icon size={26} strokeWidth={1.75} aria-hidden="true" />
            </span>
          </span>
          <span className="heard-lead">{m.lead}</span>
          <span className="heard-body">{m.body}</span>
        </li>
      ))}
    </ol>
  );
}
