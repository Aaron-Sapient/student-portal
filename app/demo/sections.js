'use client';

import {
  CalendarCheck,
  ArrowDownRight,
  ArrowUpRight,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  CircleDashed,
  ExternalLink,
  FileText,
  Video,
} from 'lucide-react';
import { useRef, useState } from 'react';
import { Bar, Halo } from '@/app/(portal)/neu';
import DemoModal from './DemoModal';
import CheckInModal from './CheckInModal';
import BookingModal from './BookingModal';
import { GaugeCluster } from '@/app/(portal)/homeSections';

/* Demo-only sections. Presentational, no hooks, no fetch: every value arrives
   as plain JSON already formatted by app/demo/demoData.js, which is what lets
   the sidebar switch sections with nothing to load and nothing to flash.

   Card titles are real headings, not all-caps kickers over a heading. The
   heading level is honest too: h1 in the sidebar identity, h2 per section, h3
   per card, so the outline reads correctly to a screen reader. */

/* ── Shared shells ──────────────────────────────────────────────────────── */

function Card({ title, sub, aside, children, className = '' }) {
  return (
    <section className={`neu-raised rounded-[2.5rem] p-7 ${className}`}>
      {(title || aside) && (
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
          {title && (
            <h3 className="font-display text-[1.3rem] font-semibold leading-snug text-ink">
              {title}
            </h3>
          )}
          {aside && <span className="text-[13px] font-medium text-ink-soft">{aside}</span>}
        </div>
      )}
      {sub && <p className="mt-1.5 max-w-[68ch] text-[14px] leading-relaxed text-ink-soft">{sub}</p>}
      <div className={title || sub ? 'mt-5' : ''}>{children}</div>
    </section>
  );
}

/* Reach / Target / Likely heads the rows beneath it. It first went the wrong
   way -- bigger, serif, competing with the school names -- so this follows what
   every mature list of grouped items does instead (ChatGPT's "Chats", Claude's
   "Chats and tasks", Siri's "Previous 7 Days"):

     the group label is SMALLER than the items it heads, not larger;
     it is LOW contrast while the items stay near-black, so the label recedes and
       the content is the only thing on the row with weight;
     it stays in the SAME typeface -- hierarchy comes from size, weight and
       colour, never from switching families;
     it sits far from the group above and close to its own rows, so proximity
       does the grouping before anything is read.

   The one thing those examples do not need is colour: their labels are time
   buckets, ours name how hard a school is to get into, so the tone stays. It is
   the only loud thing about the label, and at 12.5px against 16px semibold it
   reads as a marker rather than as another school. */
function GroupRule({ label, tone }) {
  /* The space ABOVE a group belongs to the group's wrapper, not here. This div
     is always the first child of that wrapper, so a `first:mt-0` on it matched
     every group rather than only the first, and silently cancelled the gap that
     was supposed to do the proximity grouping.

     OPTICAL, not geometric. Every school row carries py-3.5, so there is already
     14px of dead space under the last name of a group and 14px over the first
     name of the next -- invisible until a row is hovered and its ground appears.
     A margin set as if it were the whole gap therefore lands ~14px too wide at
     both ends. What the eye measures is text to text:
       above the label = 14 (row's bottom padding) + 20 (wrapper mt-5) = 34
       below the label =  2 (mb-0.5)              + 14 (row's top padding) = 16
     which reads as roughly 2:1, so the label belongs to the rows under it. */
  return (
    <div className="mb-0.5">
      <div className="flex items-center gap-3">
        <span className={`text-[12.5px] font-semibold leading-none ${tone}`}>{label}</span>
        <span className="h-px flex-1 bg-ink-faint/20" />
      </div>
    </div>
  );
}

function StatusDot({ on, onLabel, offLabel }) {
  const Icon = on ? CheckCircle2 : CircleDashed;
  return (
    <span
      className={`flex shrink-0 items-center gap-2 text-[13px] font-semibold ${
        on ? 'text-moss' : 'text-ink-soft'
      }`}
    >
      <Icon className="h-[18px] w-[18px]" strokeWidth={2.2} />
      {on ? onLabel : offLabel}
    </span>
  );
}


/* A grade moves in one direction or it does not move. The marker carries the
   PREVIOUS mark rather than a signed number, because "B+" is the thing a parent
   compares against and "+1" is a unit nobody grades in. A course that held its
   mark gets no chip: an unchanged row is the common case, and six grey "no
   change" badges would out-shout the two rows that actually moved.

   GRADE_POINTS is the product's own table, copied verbatim from gradeToPoints()
   in app/api/submitUpdateForm/route.js, which is what the real check-in already
   uses to detect a grade drop. Same scale here means the demo cannot show a
   movement the live portal would score differently, and it covers the whole
   A+..F range the check-in form offers rather than the handful this data
   happens to use. */
const GRADE_POINTS = {
  'A+': 4.0, A: 4.0, 'A-': 3.7,
  'B+': 3.3, B: 3.0, 'B-': 2.7,
  'C+': 2.3, C: 2.0, 'C-': 1.7,
  'D+': 1.3, D: 1.0, 'D-': 0.7,
  F: 0.0,
};

function GradeDelta({ grade, prev }) {
  const now = GRADE_POINTS[grade];
  const was = GRADE_POINTS[prev];
  if (now == null || was == null || now === was) return null;
  const up = now > was;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-[12px] font-semibold leading-none ${
        up ? 'bg-moss/[0.12] text-moss' : 'bg-terracotta/[0.10] text-terracotta-deep'
      }`}
    >
      <Icon className="h-3.5 w-3.5" strokeWidth={2.6} aria-hidden />
      <span className="sr-only">{up ? 'Up from' : 'Down from'} </span>
      {prev}
    </span>
  );
}

/* ── Score lines ────────────────────────────────────────────────────────────
   The pattern is lifted from the "Week by week" panel on Aaron's Personal
   Dashboard (dashboard.html, `weeklyChart` + `.hb-read` + `.hb-axis`), which had
   already solved the problem the portal's own chart has: four lines at once,
   readable at a glance, with no legend to hunt for.

   What it takes from there: a distorted 100x100 viewBox with non-scaling-stroke
   so the lines stay crisp at any width; SOLID polylines, one colour per series;
   endpoint dots positioned as absolute percentages; a readout row underneath
   that names each series and its current value, so it doubles as the legend;
   "week of" above it; and the first and last dates in the corners.

   What it drops, per the brief: the dotted grid, the dashed per-week verticals,
   and any x-axis tick labels between the two corners.

   Plotting the SCORE rather than the delta is the substantive difference from
   the shipped DeltaLines. The shipped component is untouched and still runs in
   the portal; this is a candidate for what replaces it in v2. */

const SCORE_SERIES = [
  { key: 'overall', label: 'Overall', color: 'var(--color-terracotta)', width: 3.4 },
  { key: 'academic', label: 'Academic', color: 'var(--color-moss)', width: 2.4 },
  { key: 'ec', label: 'Extracurricular', color: 'var(--color-ochre)', width: 2.4 },
  { key: 'leadership', label: 'Leadership', color: 'var(--color-terracotta-soft)', width: 2.4 },
];

function DemoScoreLines({ chart, height = 190 }) {
  /* Scrubbing, ported from the Personal Dashboard's week-by-week chart
     (dashboard.html, `.sc-hit` / `.sc-line` / `.sc-mark` + wireChart). What that
     one had already worked out, and what is kept here:

     - The readout under the chart is ALWAYS populated -- idle it shows the
       latest week -- so it doubles as the legend four unlabelled lines never
       had, and nothing is gated behind a hover a touch screen cannot perform.
     - A mouse hover is TRANSIENT: leaving releases back to the latest week. A
       touch PINS, because on a phone the finger is covering the point being
       read, so lifting it must not erase the answer.
     - The idle end-dots hide while scrubbing, or there are two sets of dots.
     - Arrow keys, Home and End step it, and the hit layer is a real slider with
       aria-valuetext, so the numbers are reachable without a pointer. */
  const pts = chart?.points;
  const [cur, setCur] = useState(null);
  const pinned = useRef(false);
  const hitRef = useRef(null);

  if (!pts || pts.length < 2) return null;

  const all = pts.flatMap((p) => SCORE_SERIES.map((s) => p[s.key]));
  const lo = Math.min(...all) - 3;
  const hi = Math.max(...all) + 3;
  const x = (i) => 3 + (i / (pts.length - 1)) * 94;
  const y = (v) => 94 - ((v - lo) / (hi - lo)) * 88;

  const last = pts.length - 1;
  const at = cur == null ? last : cur;
  const shown = pts[at];
  const live = cur != null;

  const idxAt = (clientX) => {
    const r = hitRef.current?.getBoundingClientRect();
    if (!r?.width) return last;
    const raw = Math.round((((clientX - r.left) / r.width) * 100 - 3) / 94 * last);
    return Math.max(0, Math.min(last, raw));
  };
  const release = () => {
    if (pinned.current) return;
    setCur(null);
  };
  const readoutText = (p) =>
    `Week of ${p.weekOf || chart.weekOf}: ` +
    SCORE_SERIES.map((s) => `${s.label} ${p[s.key]}`).join(', ');

  return (
    <figure className="mt-5">
      <div className="neu-inset relative rounded-2xl px-4 py-4" style={{ height }}>
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="absolute inset-x-4 inset-y-4 h-[calc(100%-2rem)] w-[calc(100%-2rem)]"
          role="img"
          aria-label={SCORE_SERIES.map(
            (s) => `${s.label} ${pts[0][s.key]} to ${pts[last][s.key]}`
          ).join('. ')}
        >
          {SCORE_SERIES.map((s) => (
            <polyline
              key={s.key}
              points={pts.map((p, i) => `${x(i).toFixed(1)},${y(p[s.key]).toFixed(1)}`).join(' ')}
              fill="none"
              stroke={s.color}
              strokeWidth={s.width}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>

        {/* The scrub line. Positioned in the same percentage space as the dots,
            inset by the container's own 1rem padding. */}
        <span
          aria-hidden
          className="demo-sc-line"
          style={{
            left: `calc(1rem + (100% - 2rem) * ${x(at) / 100})`,
            opacity: live ? 1 : 0,
          }}
        />

        {/* Dots sit outside the distorted viewBox so they stay round. They ride
            the scrub when live and rest on the last point when idle. */}
        {SCORE_SERIES.map((s) => (
          <span
            key={s.key}
            aria-hidden
            className="absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-cream"
            style={{
              left: `calc(1rem + (100% - 2rem) * ${x(at) / 100})`,
              top: `calc(1rem + (100% - 2rem) * ${y(shown[s.key]) / 100})`,
              background: s.color,
            }}
          />
        ))}

        <div
          ref={hitRef}
          className="demo-sc-hit"
          role="slider"
          tabIndex={0}
          aria-label="Score by week, drag to read a week"
          aria-valuemin={0}
          aria-valuemax={last}
          aria-valuenow={at}
          aria-valuetext={readoutText(shown)}
          onPointerDown={(e) => {
            pinned.current = true;
            setCur(idxAt(e.clientX));
            try {
              e.currentTarget.setPointerCapture(e.pointerId);
            } catch {
              /* capture unsupported */
            }
          }}
          onPointerMove={(e) => {
            if (e.pointerType === 'mouse' && !e.buttons && !pinned.current) {
              setCur(idxAt(e.clientX));
              return;
            }
            if (cur != null) setCur(idxAt(e.clientX));
          }}
          onPointerUp={(e) => {
            if (e.pointerType === 'mouse') pinned.current = false;
          }}
          onPointerCancel={() => {
            pinned.current = false;
            setCur(null);
          }}
          onPointerLeave={release}
          onBlur={() => {
            pinned.current = false;
            setCur(null);
          }}
          onKeyDown={(e) => {
            const step =
              e.key === 'ArrowLeft' ? -1
              : e.key === 'ArrowRight' ? 1
              : e.key === 'Home' ? -pts.length
              : e.key === 'End' ? pts.length
              : 0;
            if (!step) return;
            e.preventDefault();
            pinned.current = true;
            setCur(Math.max(0, Math.min(last, (cur == null ? last : cur) + step)));
          }}
        />
      </div>

      <figcaption className="mt-4">
        <p
          className={`text-[13px] font-semibold ${live ? 'text-ink' : 'text-ink-soft'}`}
        >
          Week of {shown.weekOf || chart.weekOf}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-x-6 gap-y-2">
          {SCORE_SERIES.map((s) => (
            <span key={s.key} className="inline-flex items-center gap-2 text-[14px] text-ink-soft">
              <span
                aria-hidden
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ background: s.color }}
              />
              {s.label}
              <b className="font-display text-[16px] font-semibold text-ink">{shown[s.key]}</b>
            </span>
          ))}
        </div>
        <div className="mt-3 flex justify-between text-[12px] text-ink-soft">
          <span>{chart.first}</span>
          <span>{chart.last}</span>
        </div>
      </figcaption>
    </figure>
  );
}

/* ── 1. Overview ────────────────────────────────────────────────────────── */

export function Overview({ data, go }) {
  const m = data.nextMeeting;
  return (
    <>
      {/* No headline. The strip above already says whose portal this is, and a
          sentence restating what the cards below show is the hero-and-blurb the
          rest of this page spent two passes removing. */}
      {/* No items-start: the two cards stretch to a shared bottom edge. card-fill
          then lets the gauge row inside take the slack and centre in it, so the
          extra height reads as the ring sitting in its own space rather than as
          padding dumped under the last bar. */}
      <div className="grid grid-cols-1 gap-6 min-[1025px]:grid-cols-12">
        <div className="card-hero card-fill min-[1025px]:col-span-5">
          <section className="demo-score-card neu-raised rounded-[2.5rem] p-7">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <h3 className="font-display text-[1.3rem] font-semibold leading-snug text-ink">
                Choice SuperScore
              </h3>
              <span className="rounded-full bg-ochre/[0.18] px-2.5 py-1 text-[11px] font-semibold leading-none text-ink">
                Beta
              </span>
            </div>
            {/* The shipped score card, un-carded by demo.css so this wrapper is
                the only card: same ring, same bars, same deltas, same data. */}
            <GaugeCluster scores={data.scores} />
          </section>
        </div>

        <div className="min-[1025px]:col-span-7">
          <section className="neu-raised rounded-[2.5rem] p-7">
            <h3 className="font-display text-[1.3rem] font-semibold leading-snug text-ink">
              This week’s read
            </h3>
            <p className="mt-3 max-w-[68ch] font-display text-[17px] leading-relaxed text-ink-soft">
              {data.scores.latest.insight}
            </p>
            <DemoScoreLines chart={data.chart} />
          </section>
        </div>
      </div>

      {/* A pointer, not a second copy: the meeting lives in Meetings. As raw
          text under two cards it read as a caption that had come loose, so it
          is a container in its own right -- and since the thing it points at is
          a section of this same board, it is the back door into it. The rail
          stays the front door; this is the path for someone reading the
          Overview who wants the rest of what it just mentioned. */}
      <button
        type="button"
        onClick={() => go?.('meetings')}
        className="demo-jump neu-raised mt-6 flex w-fit max-w-full flex-wrap items-center gap-x-5 gap-y-3 rounded-[2rem] px-7 py-5 text-left"
      >
        <CalendarCheck
          className="h-[22px] w-[22px] shrink-0 text-terracotta-deep"
          strokeWidth={2.1}
        />
        <span className="min-w-0 text-[15px] text-ink-soft">
          Next up, <span className="font-semibold text-ink">{m.kind.toLowerCase()} with {m.who}</span>,{' '}
          {m.dayLabel} at {m.timeLabel}.
        </span>
        <span className="flex shrink-0 items-center gap-1.5 text-[14px] font-semibold text-terracotta-deep">
          All meetings
          <ChevronRight className="h-[17px] w-[17px]" strokeWidth={2.4} aria-hidden />
        </span>
      </button>
    </>
  );
}

/* ── 2. College list ────────────────────────────────────────────────────── */

const RANGE_TONE = {
  Reach: 'text-terracotta-deep',
  Target: 'text-moss',
  Likely: 'text-ink-soft',
};

function SchoolRow({ school }) {
  /* One line when the CARD is wide enough, two when it is not -- a container
     query, not a viewport one.

     The threshold was keyed to the window twice and was wrong both times, for
     the same reason: the row lives in an 8-of-12 column inside a card inside a
     rail, so the window is three subtractions away from the width that actually
     decides. At half screen the card can be comfortably wide while the viewport
     is well under any sensible breakpoint, which is how a row with room for five
     columns ended up stacked with 500px of empty ground beside it. `@container`
     on the list lets the row ask the only question that matters: do the columns
     fit in ME. 44rem is what the row actually needs: a 12rem floor on the name, 10rem of term,
     4.5rem of deadline, 7.5rem of bar, 5.75rem of status and four 1rem gaps. The
     meta columns were trimmed to reach it, because at 1440 -- a laptop, and the
     most likely surface after the 1920 board -- the card measures 719px and the
     untrimmed row wanted 744, so it stacked over a 25px shortfall.

     Stacked, the meta spreads with justify-between instead of sitting in a
     left-packed clump, so the second line covers the same width as the name
     above it rather than trailing off. */
  return (
    <li className="py-3.5 @min-[44rem]:flex @min-[44rem]:items-center @min-[44rem]:gap-4">
      <span className="block truncate text-[16px] font-semibold text-ink @min-[44rem]:min-w-[12rem] @min-[44rem]:flex-1">
        {school.name}
      </span>
      <span className="mt-1.5 flex w-full items-center justify-between gap-4 @min-[44rem]:mt-0 @min-[44rem]:w-auto @min-[44rem]:justify-start @min-[44rem]:contents">
        <span className="w-[10rem] shrink-0 text-[13px] font-semibold text-ink-soft">
          {school.term}
        </span>
        <span className="w-[4.5rem] shrink-0 text-[13px] font-medium text-ink-soft">
          Due {school.due}
        </span>
        <span className="flex w-[7.5rem] shrink-0 items-center gap-2.5">
          <Bar value={school.pct} />
          <span className="w-10 shrink-0 text-right text-[13px] font-semibold text-ink-soft">
            {Math.round(school.pct * 100)}%
          </span>
        </span>
        <span className="w-[5.75rem] shrink-0">
          <StatusDot on={school.confirmed} onLabel="Confirmed" offLabel="Deciding" />
        </span>
      </span>
    </li>
  );
}

export function Colleges({ data }) {
  const c = data.colleges;

  /* The UC campuses come out of the main list and get their own card. Derived
     rather than stored twice, so the flag on a school is the only place that
     decides, and each card counts what it actually shows instead of both
     reporting the whole list. Each UC keeps the range it was grouped under. */
  const ucs = c.groups.flatMap((g) =>
    g.schools.filter((s) => s.uc).map((s) => ({ ...s, range: g.range }))
  );
  const groups = c.groups
    .map((g) => ({ ...g, schools: g.schools.filter((s) => !s.uc) }))
    .filter((g) => g.schools.length);
  const count = (list) => `${list.length} school${list.length === 1 ? '' : 's'}`;
  const privates = groups.flatMap((g) => g.schools);

  return (
    <>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <div className="lg:col-span-8">
          {/* Titled to match Application progress beside it: the two cards sit in
              one row, and one of them naming itself while the other did not read
              as the left card having lost its heading. */}
          <Card
            title="College list"
            aside={`${count(privates)}, ${privates.filter((s) => s.confirmed).length} confirmed`}
          >
            {groups.map((g) => (
              <div key={g.range} className="mt-5 first:mt-0">
                <GroupRule label={g.range} tone={RANGE_TONE[g.range]} />
                <ul className="@container divide-y divide-ink-faint/15">
                  {g.schools.map((s) => (
                    <SchoolRow key={s.name} school={s} />
                  ))}
                </ul>
              </div>
            ))}
          </Card>
        </div>
        <div className="flex flex-col gap-6 lg:col-span-4">
          <ApplicationCard application={data.application} />
          <UcCard ucs={ucs} label={`${ucs.length} campuses, one application`} />
        </div>
      </div>
    </>
  );
}

/* One application, one set of PIQs, four campuses. The row is deliberately not a
   SchoolRow: the term and deadline are identical across every campus, so
   repeating "Regular Decision, Due Dec 1" four times would be four lines of the
   same fact. What differs per campus is the range, so that is what the row
   carries, with the shared deadline stated once at the bottom. */
function UcCard({ ucs, label }) {
  if (!ucs.length) return null;
  const due = ucs[0]?.due;
  return (
    <Card title="University of California" aside={label}>
      <ul className="divide-y divide-ink-faint/15">
        {ucs.map((s) => (
          <li key={s.name} className="flex items-center gap-4 py-3">
            <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-ink">
              {s.name}
            </span>
            <span className={`shrink-0 text-[13px] font-semibold ${RANGE_TONE[s.range]}`}>
              {s.range}
            </span>
            <StatusDot on={s.confirmed} onLabel="Confirmed" offLabel="Deciding" />
          </li>
        ))}
      </ul>
      {due && (
        <p className="mt-4 border-t border-ink-faint/20 pt-4 text-[13px] text-ink-soft">
          One application covers all four. Due {due}.
        </p>
      )}
    </Card>
  );
}

function ApplicationCard({ application }) {
  return (
    <section className="neu-raised rounded-[2.5rem] p-7">
      <div className="flex items-baseline justify-between gap-4">
        <h3 className="font-display text-[1.3rem] font-semibold leading-snug text-ink">
          Application progress
        </h3>
        <span className="font-display text-[1.6rem] font-semibold leading-none text-ink">
          {Math.round(application.overall * 100)}%
        </span>
      </div>
      <div className="mt-4 flex max-w-[34rem]">
        <Bar value={application.overall} />
      </div>
      <p className="mt-3 text-[13px] leading-relaxed text-ink-soft">
        Round 1 opens the supplemental essays, which is where most of the remaining work sits.
      </p>
      <div className="mt-6 flex max-w-[34rem] flex-col gap-4 border-t border-ink-faint/20 pt-5">
        {application.streams.map((st) => (
          <div key={st.key}>
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[13px] font-semibold text-ink-soft">{st.label}</span>
              <span className="shrink-0 font-display text-base font-semibold leading-none text-ink">
                {Math.round(st.value * 100)}%
              </span>
            </div>
            <div className="mt-2 flex">
              <Bar value={st.value} fillClassName={st.fill} />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ── 3. Meetings ────────────────────────────────────────────────────────── */

const HW = {
  done: { icon: CheckCircle2, label: 'Homework done', cls: 'text-moss' },
  partly: { icon: CircleDashed, label: 'Partly done', cls: 'text-terracotta-deep' },
};

export function Meetings({ data }) {
  const m = data.nextMeeting;

  /* Booking is gated on the week's check-in, which is the product's actual rule
     rather than a demo flourish: the check-in is what the evaluator reads to
     decide the meeting is warranted, so there is no path to a slot that does not
     go through it. `flow` is null, 'checkin' or 'booking' -- one state, because
     the two are one errand. */
  const [flow, setFlow] = useState(null);

  return (
    <>

      {/* Next up is its own card rather than a card nested inside the log. */}
      <section className="neu-raised mb-6 flex flex-wrap items-center gap-x-8 gap-y-5 rounded-[2.5rem] p-7">
        <span className="neu-chip flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl text-terracotta">
          <Video className="h-7 w-7" strokeWidth={1.9} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="font-display text-[1.6rem] font-semibold leading-snug text-ink">
            {m.kind} with {m.who}
          </h3>
          <p className="mt-1 text-[15px] text-ink-soft">{m.agenda}</p>
        </div>
        <div className="shrink-0 text-right">
          <p className="font-display text-[1.4rem] font-semibold leading-none text-ink">
            {m.dayLabel}
          </p>
          <p className="mt-2 text-[14px] font-semibold text-ink-soft">
            {m.timeLabel}, {m.minutes} minutes
          </p>
          <button
            type="button"
            onClick={() => setFlow('checkin')}
            className="mt-4 rounded-full bg-terracotta px-5 py-2.5 text-[14px] font-semibold text-paper transition active:scale-[0.98]"
          >
            Book another
          </button>
        </div>
      </section>

      <Card title="Recent sessions">
        <ul className="divide-y divide-ink-faint/15">
          {data.sessions.map((s) => {
            const hw = HW[s.homework] || HW.partly;
            const Icon = hw.icon;
            return (
              <li key={s.id} className="flex items-start gap-6 py-4">
                <span className="w-20 shrink-0 pt-1 text-[14px] font-semibold text-ink-soft">
                  {s.dateLabel}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[16px] font-semibold text-ink">
                    {s.topic}
                    <span className="ml-2.5 text-[13px] font-medium text-ink-soft">
                      with {s.who}
                    </span>
                  </span>
                  <span className="mt-1 block max-w-[68ch] text-[14px] leading-relaxed text-ink-soft">
                    {s.note}
                  </span>
                </span>
                <span
                  className={`flex w-[9.5rem] shrink-0 items-center gap-2 pt-1 text-[13px] font-semibold ${hw.cls}`}
                >
                  <Icon className="h-[18px] w-[18px]" strokeWidth={2.2} />
                  {hw.label}
                </span>
              </li>
            );
          })}
        </ul>
      </Card>

      {/* One errand, two doors: the check-in opens first because it is the
          prerequisite, and completing it hands straight to booking rather than
          returning the student to a page to start again. */}
      <DemoModal
        open={flow === 'checkin'}
        onClose={() => setFlow(null)}
        title="This week’s check-in"
        sub="Booking opens once this is in. It takes about a minute."
      >
        <CheckInModal
          courses={data.transcript.courses}
          onComplete={() => setFlow('booking')}
        />
      </DemoModal>

      <DemoModal
        open={flow === 'booking'}
        onClose={() => setFlow(null)}
        title="Book a meeting"
        sub="Times come from the instructor's real calendar."
        wide
      >
        <BookingModal booking={data.booking} onDone={() => setFlow(null)} />
      </DemoModal>
    </>
  );
}

/* ── 4. Essays and files ────────────────────────────────────────────────── */

export function Writing({ data }) {
  return (
    <>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <div className="lg:col-span-7">
          <Card title="In progress">
            <ul className="divide-y divide-ink-faint/15">
              {data.essays.map((e) => (
                <li key={e.id} className="py-4">
                  <div className="flex items-baseline justify-between gap-5">
                    <span className="min-w-0 text-[16px] font-semibold text-ink">{e.name}</span>
                    <span className="shrink-0 text-[13px] font-medium text-ink-soft">{e.round}</span>
                  </div>
                  <div className="mt-2.5 flex items-center gap-4">
                    <span className="w-44 shrink-0 text-[14px] text-ink-soft">{e.stage}</span>
                    <Bar value={e.pct} />
                    <span className="w-10 shrink-0 text-right text-[13px] font-semibold text-ink-soft">
                      {Math.round(e.pct * 100)}%
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        </div>
        <div className="lg:col-span-5">
          <Card title="Shared files" aside={`${data.files.length} documents`}>
            <ul className="divide-y divide-ink-faint/15">
              {data.files.map((f) => (
                <li key={f.id}>
                  {/* The whole row is the control, so the hover ground and the
                      click target are the same rectangle. It opens the REAL
                      editor at /write in a new tab rather than a reader embedded
                      here: the toolbar, the tab rail, the heading outline and the
                      version history are the product, and a demo that reproduced
                      them would be showing a thing we do not ship. New tab, not
                      navigation, so the board is still behind it when Ryan comes
                      back. */}
                  <a
                    href={f.href || undefined}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="demo-row-button flex w-full items-center gap-3 py-3.5 text-left"
                  >
                    <FileText
                      className="h-[18px] w-[18px] shrink-0 text-terracotta-deep"
                      strokeWidth={2}
                    />
                    <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-ink">
                      {f.name}
                    </span>
                    <span className="shrink-0 text-[12px] font-semibold text-ink-soft">
                      {f.kind}
                    </span>
                    <span className="w-14 shrink-0 text-right text-[13px] font-medium text-ink-soft">
                      {f.dateLabel}
                    </span>
                    <ExternalLink
                      className="h-[15px] w-[15px] shrink-0 text-ink-faint"
                      strokeWidth={2.2}
                      aria-hidden
                    />
                  </a>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}

/* ── 5. The plan ────────────────────────────────────────────────────────── */

export function Plan({ data }) {
  return (
    <>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <div className="lg:col-span-5">
          <Card
            title="Transcript"
            sub={data.transcript.summary}
            aside={data.transcript.gpa}
          >
            <ul className="divide-y divide-ink-faint/15">
              {data.transcript.courses.map((c) => (
                <li key={c.id} className="flex items-baseline gap-4 py-3.5">
                  <span className="w-[4.5rem] shrink-0 text-[13px] font-semibold text-ink-soft">
                    {c.tag}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[15px] font-semibold text-ink">{c.name}</span>
                    <span className="mt-0.5 block text-[13px] leading-relaxed text-ink-soft">
                      {c.why}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2.5">
                    <GradeDelta grade={c.grade} prev={c.prev} />
                    <span className="w-[2.4rem] text-right font-display text-[1.2rem] font-semibold leading-none text-ink">
                      {c.grade}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-5 border-t border-ink-faint/20 pt-4 text-[13px] text-ink-soft">
              {data.transcript.updatedLabel}. Grades come in once a week, so a marker shows what
              moved since the last one.
            </p>
          </Card>
        </div>

        <div className="lg:col-span-7">
          <Card title="Activities and projects">
            <ul className="divide-y divide-ink-faint/15">
              {data.projects.map((p) => (
                <li key={p.id} className="py-4">
                  <div className="flex items-baseline justify-between gap-5">
                    <span className="min-w-0 text-[16px] font-semibold text-ink">{p.name}</span>
                    <span className="shrink-0 text-[13px] font-medium text-ink-soft">{p.role}</span>
                  </div>
                  <p className="mt-1 text-[14px] leading-relaxed text-ink-soft">{p.detail}</p>
                  <div className="mt-2.5 flex items-center gap-4">
                    <Bar value={p.pct} />
                    <span className="w-10 shrink-0 text-right text-[13px] font-semibold text-ink-soft">
                      {Math.round(p.pct * 100)}%
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>

      <div className="mt-6">
        <Card title="The season">
          <ol className="grid grid-cols-1 gap-6 md:grid-cols-3">
            {data.phases.map((p) => (
              <li key={p.key}>
                <div className="flex items-center gap-3">
                  {p.done ? (
                    <CheckCircle2 className="h-[18px] w-[18px] text-moss" strokeWidth={2.4} />
                  ) : p.live ? (
                    <span className="neu-pulse h-3.5 w-3.5 rounded-full bg-terracotta" />
                  ) : (
                    <span className="h-3.5 w-3.5 rounded-full border-2 border-ink-soft/50" />
                  )}
                  <span className="text-[16px] font-semibold text-ink">{p.name}</span>
                  <span className="text-[13px] font-medium text-ink-soft">{p.range}</span>
                </div>
                {p.current && (
                  <p className="mt-1.5 pl-[30px] text-[14px] font-semibold text-terracotta-deep">
                    {p.live ? 'Here now' : 'Up next'}
                  </p>
                )}
                <p className="mt-2 pl-[30px] text-[14px] leading-relaxed text-ink-soft">{p.work}</p>
                {p.milestone && (
                  <p
                    className={`mt-2.5 ml-[30px] inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-[12px] font-semibold ${
                      p.milestone.passed
                        ? 'bg-moss/[0.12] text-moss'
                        : 'bg-terracotta/[0.10] text-terracotta-deep'
                    }`}
                  >
                    {p.milestone.passed ? (
                      <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={2.4} />
                    ) : (
                      <CircleAlert className="h-3.5 w-3.5" strokeWidth={2.4} />
                    )}
                    {p.milestone.name}, {p.milestone.date}
                  </p>
                )}
              </li>
            ))}
          </ol>
        </Card>
      </div>
    </>
  );
}
