/* HEAVY MODE: everything we do, on the page (2026-09-08, Aaron).
   ─────────────────────────────────────────────────────────────────────────
   Ryan's read of a family who has escalated, in his words: "the longer and
   heavier, the better. they love it." A light page gauges interest and is
   therefore short and price-free; a heavy page is for a family who has already
   shown it, and its job is the opposite one — leave nothing for them to have to
   ask about.

   GENERIC, AND THAT IS THE DESIGN RATHER THAN A SHORTCUT. The first heavy spec
   built each page from Ryan's own saved quote in the package builder, which is
   the better page and cannot ship today: Ryan did not record which of his
   in-person initials he deemed heavy, so there are no quotes to render. This
   version needs nothing per family. Flip `mode` to "heavy" on any row and the
   whole detail appears, keyed only by which brochure that student's grade band
   belongs to. When the quotes exist, a per-family options block goes ABOVE this
   without replacing it: the specific offer first, the full catalogue under it.

   THE CONTENT IS THE BROCHURES', not new writing. Every line below is lifted
   from `03. Pamphlets/Business Promotions/High School Packages - Grades 9-11`
   and `... - Senior Year`, which are the wording authority, and checked against
   `Claude_Services.md` for the facts. Two things are deliberately NOT carried
   over, both barred by Claude_Lead Pages.md 2.5: the 2025-26 results line, which
   says internships were "placed" and reads to a family as a placement promise;
   and any firm fact the services bible does not hold (headcount, the New York
   office). The Internship & Research entry keeps the brochure's own disclaimer
   for exactly the same reason.

   NO FIGURES HERE. Heavy lifts the light ruling on price, but a GENERIC heavy
   has no family-specific quote to print, and inventing a rate card in the page
   body would be worse than the pamphlet that already carries one. The
   fee-bearing pamphlet is switched on for heavy rows instead, which is where
   the real numbers live and where Ryan has already approved how they read. */

const NINE_TO_ELEVEN = {
  band: 'Grades 9 to 11',
  intro:
    'Three paths through the underclassman years. The academic record, the activity profile and the story all get built long before senior-year deadlines arrive.',
  compare: {
    heading: 'What changes by tier.',
    rows: [
      { feature: 'Meeting cadence', comprehensive: 'Biweekly 1:1', vip: 'Weekly 1:1, with task tracking' },
      { feature: 'Academic blueprint', comprehensive: 'Full academic and testing plan', vip: 'Competitive academic strategy for target schools' },
      { feature: 'Activity and leadership', comprehensive: 'Leadership development plan', vip: 'Advanced leadership and project planning' },
      { feature: 'Summer planning', comprehensive: 'Curated shortlist of options', vip: 'Fully customized competitive summer strategy' },
      { feature: 'College list, 5 schools', comprehensive: 'Strategy and refinement', vip: 'Deeper refinement and targeting' },
      { feature: 'Common App support', comprehensive: 'Full development across 2 to 3 drafts', vip: 'Integrated weekly across several drafts' },
      { feature: 'Supplements, 5 schools', comprehensive: 'Up to 2 rounds per essay', vip: 'Multiple rounds, integrated weekly' },
      { feature: 'Waitlist and appeals', comprehensive: 'Not included', vip: 'Included for 5 schools' },
    ],
    tail: 'Ultra VIP carries everything in VIP, scoped personally in conversation.',
  },
  addons: {
    heading: 'The add-on programs.',
    lead: 'Four categories. They layer onto any package, on schedules of their own, and you take as many as the plan calls for.',
    groups: [
      {
        name: 'Application',
        line: 'Extra colleges.',
        items: [
          'Five schools come standard with every package',
          'Up to 20 more can be added, for a list of 25 at most',
          'The UC system counts as one school: all nine campuses share one application',
        ],
      },
      {
        name: 'Mentorship',
        line: 'Competitions, internships and projects.',
        items: [
          'Competitions, five or ten, choose one track',
          'Internship and research search, up to three. A search program: resume, LinkedIn and outreach guidance. We do not place students and we do not promise placement',
          'Group project, up to five',
          'Solo passion project, up to two',
          'Real mentorship from ideation to finalization, with weekly meetings and detailed feedback',
        ],
      },
      {
        name: 'Test prep',
        line: 'SAT preparation, sized to the score gap and the timeline.',
        items: [
          'Group SAT, repeatable up to three times',
          'SAT Popular or Premium Combo, choose one; the two are mutually exclusive',
          'Every package already runs a testing plan inside the regular meetings, whether or not you add one of these',
        ],
      },
      {
        name: 'Coaching',
        line: 'Advanced Placement tutoring, one to one.',
        items: [
          'Senior AP tutor, in five or ten hour blocks, for deeper subject expertise',
          'Junior AP tutor, in five or ten hour blocks, a strong fit for foundational and review work',
        ],
      },
    ],
  },
  runway: {
    heading: 'What the runway covers.',
    items: [
      { lead: 'Grade 9, three years out', body: 'Three years of meetings, summer planning and course selection before the first application is due.' },
      { lead: 'Grade 10, two years out', body: 'The same work, with more room left to build the record than to present it.' },
      { lead: 'Grade 11, one year out', body: 'One year, with the academic and testing plan, the college list and the Common App all running together.' },
    ],
  },
  questions: {
    heading: 'What families ask first.',
    items: [
      { lead: 'How do the competitions programs work?', body: 'We pick the ones that fit your student, manage the timelines, mentor the execution, and make sure the work is submitted.' },
      { lead: 'Does the internship program place my student?', body: 'No. It is a search program: resume, LinkedIn and outreach guidance. There is no placement guarantee.' },
      { lead: 'How do you count schools?', body: 'The UC system counts as one. All nine UC campuses share a single application.' },
      { lead: 'Is test planning part of every package?', body: 'Yes. Score targets, test-date strategy and practice milestones run inside the regular meetings, whether or not you add an SAT program.' },
    ],
  },
};

const SENIOR = {
  band: 'Senior year',
  intro:
    'By August, every essay deadline, every school-list decision and every supplement has direct consequences. There is no time left for theory or four-year roadmaps. Every senior engagement is scoped personally to your student, and there is no fixed menu to choose from.',
  compare: {
    heading: 'What senior year support includes.',
    lead: 'The scope flexes with the engagement: how many schools, how many essays, how much of the season is left. Your written proposal spells out exactly where your student lands on each of these.',
    rows: [
      { feature: 'Meeting cadence', comprehensive: 'Sessions or weekly 1:1s, sized to the list and to how much of the season remains, from a handful of focused sessions up to several meetings a week through the fall' },
      { feature: 'Essay revisions', comprehensive: 'Edit rounds sized to what the essay needs, from one full round up to unlimited edits within the season' },
      { feature: 'Turnaround', comprehensive: 'Tightens as deadlines approach, with a priority lane near the busiest dates' },
      { feature: 'School strategy', comprehensive: 'List refinement for every engagement, extending to full narrative architecture across larger or more competitive lists' },
      { feature: 'Submission QC', comprehensive: 'A readiness check before every application goes in' },
      { feature: 'Parent access', comprehensive: 'Email-based, with more direct access on higher-touch engagements' },
      { feature: 'Interview support', comprehensive: 'Available as an add-on, or built in for families who want it' },
      { feature: 'Post-decision', comprehensive: 'Deferrals, updates, continued interest letters, waitlist and appeals, scoped to what the season calls for' },
    ],
  },
  shapes: {
    heading: 'What shapes your proposal.',
    lead: 'No two seniors need the same thing. Yours reflects the specifics below, worked out together in the consultation.',
    items: [
      'How many schools are on the list, and how competitive each one is',
      'How many essays and supplements need real editorial support',
      'How much of the season is already behind you',
      'How often you want to meet, and how directly you want Ryan involved',
      'Whether an EC Booster or test prep is part of the plan',
      'Whether interview support is built in or added on',
    ],
  },
  addons: {
    heading: 'The EC Booster.',
    lead: 'The activities list, the awards section and the "why us" supplements all draw on the same source: the student’s actual track record. By October there is no time left to build, only to present. The Booster runs June through November, while there is still time to add real work and frame what already exists.',
    groups: [
      {
        name: 'Every level',
        line: 'Assess and organize.',
        items: [
          'Full audit and prioritization of current activities',
          'Common App activities list optimization',
          'Honors and awards list strategy',
          'Resume rebuild for scholarship use',
          'LinkedIn cleanup and rewrite',
          'Narrative coherence across the profile',
        ],
      },
      {
        name: 'Level 1, Polish',
        line: 'Best fit when the activities exist already and need one anchor and clean presentation.',
        items: ['One capstone outcome of your choice', 'A passion project, research, or a competition', 'Three months of mentor support'],
      },
      {
        name: 'Level 2, Build',
        line: 'Best fit when activities exist but lack standout work, and the college narrative is still firming up.',
        items: ['One deep passion project plus one supporting outcome', 'The outcome can be research or a competition', 'Four months of mentor support'],
      },
      {
        name: 'Level 3, Transform',
        line: 'Best fit when the profile is thin or scattered, with limited time to build standout work before applications open.',
        items: ['Two passion projects, fully developed', 'A research or competition track included', 'Five months of intensive mentor support'],
      },
    ],
  },
  runway: {
    heading: 'Application support and EC work, together.',
    items: [
      { lead: 'June through November', body: 'The Booster window closes as applications open, so both halves get decided in the same conversation or the earlier one is gone.' },
      { lead: 'One track record, three surfaces', body: 'The activities list, the awards section and the "why us" supplements all draw on the same work. Build it once and it pays into all three.' },
      { lead: 'One calendar', body: 'Essay deadlines and mentor milestones sequenced against each other, rather than competing for the same weeks of the fall.' },
    ],
  },
  questions: {
    heading: 'Three things worth knowing.',
    items: [
      { lead: 'Competitions', body: 'We pick the ones that fit your student, manage the timelines, mentor the execution, and make sure the work is submitted.' },
      { lead: 'Internship and research', body: 'A search program: resume, LinkedIn and outreach guidance. We do not place students, and we do not promise placement.' },
      { lead: 'Testing', body: 'Every engagement runs a testing plan inside the regular meetings: score targets, test dates, practice milestones, whether or not you add test prep.' },
    ],
  },
};

/* The band is a property of the STUDENT, so it is read off the row rather than
   guessed here. `band` wins; otherwise the senior pamphlet's own filename in
   `packagesPdfHref` is the tell, because a row that links the senior overview is
   a senior. Anything else is the underclassman book, which is also the safer
   default: it names its tiers, and a senior shown tier names would contradict
   the senior pamphlet, which prints none. */
export function heavyBandFor(lead) {
  if (lead?.band === 'senior' || lead?.band === '9-11') return lead.band;
  return /senior/i.test(lead?.packagesPdfHref || '') ? 'senior' : '9-11';
}

export default function HeavyDetail({ band }) {
  const c = band === 'senior' ? SENIOR : NINE_TO_ELEVEN;
  return (
    <div className="heavy">
      <p className="heavy-intro">{c.intro}</p>

      <section className="heavy-block">
        <h3 className="heavy-h">{c.compare.heading}</h3>
        {c.compare.lead && <p className="heavy-lead">{c.compare.lead}</p>}
        <dl className="heavy-compare">
          {c.compare.rows.map((r) => (
            <div className="heavy-compare-row" key={r.feature}>
              <dt className="heavy-feature">{r.feature}</dt>
              <dd className="heavy-values">
                {/* A senior row carries ONE value, because the senior book has no
                    tiers to compare; the underclassman rows carry two and the
                    tier is named, because that book does. Same markup either
                    way, so nothing has to know which it is rendering. */}
                {r.vip ? (
                  <>
                    <span className="heavy-value">
                      <span className="heavy-tier">Comprehensive</span>
                      {r.comprehensive}
                    </span>
                    <span className="heavy-value">
                      <span className="heavy-tier">VIP</span>
                      {r.vip}
                    </span>
                  </>
                ) : (
                  <span className="heavy-value">{r.comprehensive}</span>
                )}
              </dd>
            </div>
          ))}
        </dl>
        {c.compare.tail && <p className="heavy-tail">{c.compare.tail}</p>}
      </section>

      {c.shapes && (
        <section className="heavy-block">
          <h3 className="heavy-h">{c.shapes.heading}</h3>
          <p className="heavy-lead">{c.shapes.lead}</p>
          <ul className="ticks heavy-ticks">
            {c.shapes.items.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        </section>
      )}

      <section className="heavy-block">
        <h3 className="heavy-h">{c.addons.heading}</h3>
        <p className="heavy-lead">{c.addons.lead}</p>
        <div className="heavy-groups">
          {c.addons.groups.map((g) => (
            <div className="heavy-group" key={g.name}>
              <p className="heavy-group-name">{g.name}</p>
              <p className="heavy-group-line">{g.line}</p>
              <ul className="ticks heavy-ticks">
                {g.items.map((i) => (
                  <li key={i}>{i}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      <section className="heavy-block">
        <h3 className="heavy-h">{c.runway.heading}</h3>
        <dl className="heavy-compare">
          {c.runway.items.map((i) => (
            <div className="heavy-compare-row" key={i.lead}>
              <dt className="heavy-feature">{i.lead}</dt>
              <dd className="heavy-values">
                <span className="heavy-value">{i.body}</span>
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="heavy-block">
        <h3 className="heavy-h">{c.questions.heading}</h3>
        <dl className="heavy-compare">
          {c.questions.items.map((i) => (
            <div className="heavy-compare-row" key={i.lead}>
              <dt className="heavy-feature">{i.lead}</dt>
              <dd className="heavy-values">
                <span className="heavy-value">{i.body}</span>
              </dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}
