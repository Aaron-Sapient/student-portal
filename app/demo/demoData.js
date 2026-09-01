import { DateTime } from 'luxon';
import { ZONE } from '@/app/(portal)/portalUtils';

/* ── The spoof student ──────────────────────────────────────────────────────
   Every value on /demo comes from this file. There is no fetch, no Supabase,
   no Sheets, no Clerk user, no cron — by design: this page is narrated in a
   room during a proposal, and a live read is a live failure mode in front of a
   family.

   Dates are the one thing that CANNOT be frozen: a hard-coded "March 4" reads
   as a dead page the moment the room looks at it. So every date is an OFFSET in
   days from render time. The page therefore stays plausibly "today" forever
   while still touching nothing outside this module. */

export const STUDENT = {
  name: 'Maya Ellison',
  first: 'Maya',
  gradYear: 2027,
  year: 'Senior',
  school: 'Northwood High School',
  counselor: 'Ryan Choice',
  essayCoach: 'Aaron Blumenthal',
  startedMonthsAgo: 14,
};

// One clock for the whole page, so nothing renders two different "todays".
export function now() {
  return DateTime.now().setZone(ZONE);
}

const ago = (base, d) => base.minus({ days: d }).toISODate();
// Next meeting is a weekday, always: a Saturday session on the board reads as
// made-up to any parent who has ever booked one.
const nextWeekday = (base, d) => {
  let t = base.plus({ days: d });
  while (t.weekday > 5) t = t.plus({ days: 1 });
  return t;
};

/* Choice Score — six check-ins climbing, most recent first in the reader's
   mind but oldest-first in the array (what ScoreReadout expects). */
const CURVE = [
  { d: 77, overall: 61, academic: 64, ec: 58, leadership: 55 },
  { d: 63, overall: 64, academic: 67, ec: 61, leadership: 58 },
  { d: 49, overall: 66, academic: 68, ec: 66, leadership: 59 },
  { d: 35, overall: 70, academic: 70, ec: 73, leadership: 62 },
  { d: 21, overall: 73, academic: 73, ec: 79, leadership: 66 },
  { d: 7, overall: 78, academic: 78, ec: 83, leadership: 72 },
];

const INSIGHT =
  'Two things moved this week. The 1470 from the August sitting is on file, which puts ' +
  'Maya above the median for every school currently on her list — including the two reaches. ' +
  'And the Coastal Cleanup role finally has a title attached to it, which is what lifted ' +
  'leadership six points, not the hours. Round 1 supplements are now the only thing between ' +
  'here and a finished application.';

export function buildDemo(base = now()) {
  const history = CURVE.map(({ d, ...s }) => ({ date: ago(base, d), ...s }));
  const latest = { ...history[history.length - 1], insight: INSIGHT };
  const prev = history[history.length - 2];

  return {
    today: base,
    scores: { latest, prev, history, stale: false },
    progress: { value: 0.62, count: 3 },

    /* The application: three workstreams, the same three the real Colleges tab
       gauges (Common App tasks, UC PIQs, supplementals). */
    application: {
      overall: 0.34,
      streams: [
        { key: 'ca', label: 'Common App', value: 0.86, fill: 'bg-gradient-to-r from-moss/70 to-moss' },
        { key: 'uc', label: 'UC PIQs', value: 0.5, fill: 'bg-gradient-to-r from-ochre/70 to-ochre' },
        {
          key: 'sup',
          label: 'Supplementals',
          value: 0.18,
          fill: 'bg-gradient-to-r from-terracotta-soft/80 to-terracotta-soft',
        },
      ],
    },

    colleges: {
      onList: 12,
      confirmed: 8,
      goal: 12,
      groups: [
        {
          range: 'Reach',
          schools: [
            { name: 'Stanford University', term: 'REA', pct: 0.35, confirmed: true },
            { name: 'Duke University', term: 'ED', pct: 0.6, confirmed: true },
            { name: 'Northwestern University', term: 'RD', pct: 0.1, confirmed: false },
            { name: 'UC Berkeley', term: 'RD', pct: 0.45, confirmed: true },
          ],
        },
        {
          range: 'Target',
          schools: [
            { name: 'USC', term: 'EA', pct: 0.55, confirmed: true },
            { name: 'UCLA', term: 'RD', pct: 0.45, confirmed: true },
            { name: 'UC San Diego', term: 'RD', pct: 0.45, confirmed: true },
            { name: 'University of Michigan', term: 'EA', pct: 0.3, confirmed: true },
            { name: 'Boston University', term: 'ED2', pct: 0.0, confirmed: false },
          ],
        },
        {
          range: 'Likely',
          schools: [
            { name: 'UC Irvine', term: 'RD', pct: 0.45, confirmed: true },
            { name: 'Purdue University', term: 'EA', pct: 0.2, confirmed: false },
            { name: 'Cal Poly SLO', term: 'RD', pct: 0.0, confirmed: false },
          ],
        },
      ],
    },

    nextMeeting: {
      with: 'Aaron',
      kind: 'Essay session',
      minutes: 45,
      when: nextWeekday(base, 4).set({ hour: 17, minute: 30 }),
      agenda: '“Why Duke” — second draft, line edits',
    },

    sessions: [
      {
        d: 3,
        with: 'Aaron',
        topic: 'Common App personal statement',
        note: 'Cut the opening two paragraphs; the essay starts at the tide pool.',
        homework: 'done',
      },
      {
        d: 10,
        with: 'Ryan',
        topic: 'Round 1 list lock',
        note: 'Duke moves to ED. Northwestern stays on the list pending a supplement read.',
        homework: 'done',
      },
      {
        d: 17,
        with: 'Aaron',
        topic: 'UC PIQ 1 — leadership',
        note: 'The Coastal Cleanup story is the strongest thing she has. Lead with it.',
        homework: 'partly',
      },
      {
        d: 24,
        with: 'Aaron',
        topic: 'Activities list',
        note: 'Ten slots filled, ordered by hours. Reordered by weight instead.',
        homework: 'done',
      },
      {
        d: 31,
        with: 'Ryan',
        topic: 'August SAT debrief',
        note: '1470 superscored. No third sitting — the time goes to essays.',
        homework: 'done',
      },
    ],

    files: [
      { name: 'Personal statement — draft 4', kind: 'Common App', d: 3 },
      { name: '“Why Duke” — draft 2', kind: 'Supplemental', d: 5 },
      { name: 'UC PIQ 1 · Leadership — draft 3', kind: 'UC', d: 9 },
      { name: 'Activities list — final', kind: 'Common App', d: 16 },
      { name: 'Résumé — Fall 2026', kind: 'Shared', d: 23 },
    ],

    coachNote:
      'Maya is about three weeks ahead of where most of this cohort sits at this point in the fall. ' +
      'The main essay is finished in everything but polish, which means the whole of ' +
      'Round 1 can go to supplements.',
  };
}

export const sessionDate = (base, d) => base.minus({ days: d });
export const fileDate = (base, d) => base.minus({ days: d });
