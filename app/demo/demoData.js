import { DateTime } from 'luxon';
import { ZONE } from '@/app/(portal)/portalUtils';

/* ── The spoof student ──────────────────────────────────────────────────────
   Every value on /demo comes from this file. There is no fetch, no Supabase,
   no Sheets, no Clerk user, no cron. That is the hardening decision for this
   surface, not an omission: the page is narrated in a room during a proposal,
   so it is built with no code path that can enter a loading, empty, error or
   permission state. There is nothing to fail in front of a family.

   Dates are the one thing that CANNOT be frozen: a hard-coded "March 4" reads
   as a dead page the moment the room looks at it. So every date is an OFFSET in
   days from render time, and this module hands the client PLAIN JSON with the
   labels already formatted. No DateTime object crosses the server boundary,
   which is what lets section switching be pure in-memory state with no refetch
   and no flash.

   House copy rule: no em dashes anywhere a parent can read them. */

/* Grad year is DERIVED, never typed: a senior inside the cycle that ends in
   December of year Y graduates the following spring. A hardcoded "class of 2027"
   is correct today and quietly wrong from next autumn, in a file nobody reopens. */
export const STUDENT = {
  name: 'Maya Ellison',
  first: 'Maya',
  year: 'Senior',
  school: 'Northwood High School',
  counselor: 'Ryan Choice',
  essayCoach: 'Aaron Blumenthal',
};

export function now() {
  return DateTime.now().setZone(ZONE);
}

const iso = (base, d) => base.minus({ days: d }).toISODate();
const label = (base, d, fmt = 'LLL d') => base.minus({ days: d }).toFormat(fmt);

// Next meeting is a weekday, always: a Saturday session on the board reads as
// made up to any parent who has ever booked one.
const nextWeekday = (base, d) => {
  let t = base.plus({ days: d });
  while (t.weekday > 5) t = t.plus({ days: 1 });
  return t;
};

/* Choice Score: six check-ins climbing. Oldest first, which is the order the
   product's ScoreReadout expects. */
const CURVE = [
  { d: 77, overall: 61, academic: 64, ec: 58, leadership: 55 },
  { d: 63, overall: 63, academic: 66, ec: 60, leadership: 57 },
  { d: 49, overall: 66, academic: 68, ec: 63, leadership: 60 },
  { d: 35, overall: 70, academic: 71, ec: 67, leadership: 63 },
  { d: 21, overall: 74, academic: 74, ec: 72, leadership: 67 },
  { d: 7, overall: 79, academic: 78, ec: 78, leadership: 72 },
];

const INSIGHT =
  'The 1470 is on file, which puts Maya above the median at every school on her list, both ' +
  'reaches included. Leadership moved six points because the Coastal Cleanup role finally has ' +
  'a title on it, not because of the hours. Round 1 supplements are all that stands between ' +
  'here and a finished application.';


export function buildDemo(base = now()) {
  const history = CURVE.map(({ d, ...s }) => ({ date: iso(base, d), ...s }));
  const latest = { ...history[history.length - 1], insight: INSIGHT };
  const prev = history[history.length - 2];
  const meetingAt = nextWeekday(base, 4).set({ hour: 17, minute: 30 });

  /* The admissions cycle runs Jun 15 to Dec 15 and belongs to the calendar year
     of its fall deadlines. Pick the cycle whose END is still ahead of us, so
     "you are here" is answerable on every day of the year. The naive
     `month >= 4 ? year : year - 1` rule left December-through-March renders with
     every phase complete, no live phase, and last year's dates printed with no
     year beside them: a dead card in front of a family, months after anyone
     looked at it. */
  const cycleYear =
    base > DateTime.fromObject({ year: base.year, month: 12, day: 15 }, { zone: ZONE }).endOf('day')
      ? base.year + 1
      : base.year;
  const y = cycleYear;
  const phaseDate = (m, d) => DateTime.fromObject({ year: y, month: m, day: d }, { zone: ZONE });
  const phaseRow = (key, name, work, s, e, milestone) => {
    const start = phaseDate(...s);
    const end = phaseDate(...e);
    return {
      key,
      name,
      work,
      range: `${start.toFormat('LLL d')} to ${end.toFormat('LLL d')}`,
      done: base > end.endOf('day'),
      live: base <= end.endOf('day') && base >= start.startOf('day'),
      upcoming: base < start.startOf('day'),
      milestone: milestone
        ? {
            name: milestone[0],
            date: phaseDate(...milestone[1]).toFormat('LLL d'),
            passed: base > phaseDate(...milestone[1]).endOf('day'),
          }
        : null,
    };
  };

  const phases = [
    phaseRow('summer', 'Summer', 'Common App main essay and UC personal insight questions', [6, 15], [8, 31]),
    phaseRow('r1', 'Round 1', 'Early Decision, Early Action and restrictive rounds', [9, 1], [10, 15], [
      'List locked',
      [9, 1],
    ]),
    phaseRow('r2', 'Round 2', 'Early Decision II and Regular Decision', [10, 16], [12, 15], [
      'UC applications due',
      [12, 1],
    ]),
  ];
  /* Exactly one phase is "current": the first one that has not ended. The cycle
     was chosen above so that this always exists. */
  const currentPhase = phases.find((p) => !p.done);
  for (const p of phases) p.current = p === currentPhase;


  return {
    student: { ...STUDENT, gradYear: cycleYear + 1 },
    todayLabel: base.toFormat('cccc, LLLL d'),
    scores: { latest, prev, history, stale: false },

    application: {
      overall: 0.34,
      streams: [
        {
          key: 'ca',
          label: 'Common App',
          value: 0.86,
          fill: 'bg-gradient-to-r from-moss/70 to-moss',
        },
        { key: 'uc', label: 'UC essays', value: 0.5, fill: 'bg-gradient-to-r from-ochre/70 to-ochre' },
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
      groups: [
        {
          range: 'Reach',
          note: 'Admit rates under 10 percent. Two of these carry a binding or restrictive round.',
          schools: [
            { name: 'Stanford University', term: 'Restrictive Early Action', due: 'Nov 1', pct: 0.35, confirmed: true },
            { name: 'Duke University', term: 'Early Decision', due: 'Nov 1', pct: 0.6, confirmed: true },
            {
              name: 'Northwestern University',
              term: 'Regular Decision',
              due: 'Jan 2',
              pct: 0.1,
              confirmed: false,
            },
            { name: 'UC Berkeley', term: 'Regular Decision', due: 'Dec 1', pct: 0.45, confirmed: true },
          ],
        },
        {
          range: 'Target',
          note: 'Her academic profile sits at or above the middle 50 percent at all five.',
          schools: [
            { name: 'USC', term: 'Early Action', due: 'Nov 1', pct: 0.55, confirmed: true },
            { name: 'UCLA', term: 'Regular Decision', due: 'Dec 1', pct: 0.45, confirmed: true },
            { name: 'UC San Diego', term: 'Regular Decision', due: 'Dec 1', pct: 0.45, confirmed: true },
            {
              name: 'University of Michigan',
              term: 'Early Action',
              due: 'Nov 1',
              pct: 0.3,
              confirmed: true,
            },
            { name: 'Boston University', term: 'Early Decision II', due: 'Jan 4', pct: 0.0, confirmed: false },
          ],
        },
        {
          range: 'Likely',
          note: 'Strong outcomes she can count on, so the reaches stay genuinely optional.',
          schools: [
            { name: 'UC Irvine', term: 'Regular Decision', due: 'Dec 1', pct: 0.45, confirmed: true },
            { name: 'Purdue University', term: 'Early Action', due: 'Nov 1', pct: 0.2, confirmed: false },
            { name: 'Cal Poly SLO', term: 'Regular Decision', due: 'Nov 30', pct: 0.0, confirmed: false },
          ],
        },
      ],
    },

    nextMeeting: {
      kind: 'Essay session',
      who: 'Aaron',
      minutes: 45,
      dayLabel: meetingAt.toFormat('cccc, LLLL d'),
      timeLabel: meetingAt.toFormat('h:mm a'),
      agenda: '“Why Duke”, second draft, line edits',
    },

    sessions: [
      {
        id: 's1',
        dateLabel: label(base, 3),
        who: 'Aaron',
        topic: 'Common App personal statement',
        note: 'Cut the opening two paragraphs. The essay starts at the tide pool.',
        homework: 'done',
      },
      {
        id: 's2',
        dateLabel: label(base, 10),
        who: 'Ryan',
        topic: 'Round 1 list lock',
        note: 'Duke moves to Early Decision. Northwestern stays on the list pending a supplement read.',
        homework: 'done',
      },
      {
        id: 's3',
        dateLabel: label(base, 17),
        who: 'Aaron',
        topic: 'UC essay 1, leadership',
        note: 'The Coastal Cleanup story is the strongest thing she has. Lead with it.',
        homework: 'partly',
      },
      {
        id: 's4',
        dateLabel: label(base, 24),
        who: 'Aaron',
        topic: 'Activities list',
        note: 'Ten slots filled and ordered by hours. Reordered by weight instead.',
        homework: 'done',
      },
      {
        id: 's5',
        dateLabel: label(base, 31),
        who: 'Ryan',
        topic: 'SAT debrief',
        note: '1470 superscored. No third sitting, so the time goes to essays.',
        homework: 'done',
      },
      {
        id: 's6',
        dateLabel: label(base, 45),
        who: 'Ryan',
        topic: 'Summer program wrap',
        note: 'Research abstract submitted to the regional symposium.',
        homework: 'done',
      },
    ],

    essays: [
      {
        id: 'e1',
        name: 'Personal statement',
        where: 'Common App',
        round: 'Every school',
        stage: 'Draft 4, polish only',
        pct: 0.92,
      },
      {
        id: 'e2',
        name: 'Personal insight question 1, leadership',
        where: 'UC application',
        round: 'UC, due Dec 1',
        stage: 'Draft 3 with Aaron',
        pct: 0.7,
      },
      {
        id: 'e3',
        name: 'Personal insight question 2, creative side',
        where: 'UC application',
        round: 'UC, due Dec 1',
        stage: 'Draft 1',
        pct: 0.35,
      },
      {
        id: 'e4',
        name: '“Why Duke”',
        where: 'Duke supplement',
        round: 'Round 1, Early Decision',
        stage: 'Draft 2, in session Monday',
        pct: 0.6,
      },
      {
        id: 'e5',
        name: 'Short answers, five prompts',
        where: 'Stanford supplement',
        round: 'Round 1, Restrictive Early Action',
        stage: 'Two of five drafted',
        pct: 0.35,
      },
      {
        id: 'e6',
        name: 'Writing supplement',
        where: 'USC supplement',
        round: 'Round 1, Early Action',
        stage: 'Outlined',
        pct: 0.2,
      },
      {
        id: 'e7',
        name: 'Community essay',
        where: 'Michigan supplement',
        round: 'Round 1, Early Action',
        stage: 'Not started',
        pct: 0.0,
      },
    ],

    files: [
      { id: 'f1', name: 'Personal statement, draft 4', kind: 'Common App', dateLabel: label(base, 3) },
      { id: 'f2', name: '“Why Duke”, draft 2', kind: 'Supplemental', dateLabel: label(base, 5) },
      { id: 'f3', name: 'UC essay 1, draft 3', kind: 'UC', dateLabel: label(base, 9) },
      { id: 'f4', name: 'Activities list, final', kind: 'Common App', dateLabel: label(base, 16) },
      { id: 'f5', name: `Résumé, ${label(base, 23, 'LLLL yyyy')}`, kind: 'Shared', dateLabel: label(base, 23) },
      { id: 'f6', name: 'SAT score report', kind: 'Testing', dateLabel: label(base, 31) },
    ],

    /* The plan: what was promised in writing. Course plan, then activities and
       projects with status bars, then the season. */
    coursePlan: {
      summary: 'Seven AP courses across four years, five of them in the last two.',
      courses: [
        { id: 'c1', name: 'Calculus BC', tag: 'AP', why: 'Core for engineering applications' },
        { id: 'c2', name: 'Physics C, Mechanics', tag: 'AP', why: 'Pairs with the research work' },
        { id: 'c3', name: 'English Literature', tag: 'AP', why: 'Writing load supports the essays' },
        { id: 'c4', name: 'Environmental Science', tag: 'AP', why: 'Ties directly to Coastal Cleanup' },
        { id: 'c5', name: 'Spanish IV', tag: 'Honors', why: 'Fourth year of language, as UCs prefer' },
        { id: 'c6', name: 'Marine Biology Seminar', tag: 'Elective', why: 'Regional symposium credit' },
      ],
    },

    projects: [
      {
        id: 'p1',
        name: 'Coastal Cleanup Initiative',
        role: 'Founder and lead, 3 schools',
        detail: 'Charter signed, second chapter opening in October.',
        pct: 0.75,
      },
      {
        id: 'p2',
        name: 'Tide pool biodiversity paper',
        role: 'With Ryan',
        detail: 'Submitted to the regional symposium in July. Accepted.',
        pct: 1,
      },
      {
        id: 'p3',
        name: 'Varsity track, team captain',
        role: 'Third season',
        detail: 'Captain since spring. Season resumes in February.',
        pct: 0.6,
      },
      {
        id: 'p4',
        name: 'Peer tutoring, chemistry',
        role: '120 hours logged',
        detail: 'Continuing through the fall at two hours a week.',
        pct: 0.9,
      },
    ],

    phases,
  };
}
