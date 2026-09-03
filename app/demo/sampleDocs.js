/* The demo's sample documents, and the ONLY copy of their markdown.

   This module is imported by TWO consumers that must never drift apart:
   app/demo/demoData.js, which lists them on the Essays and files section, and
   the seeding script that writes them into Supabase as real md_tabs so the same
   documents open in the product's own /write editor. If the body lived in one
   of those, the other would be showing something else.

   Deliberately dependency-free -- no luxon, no `@/` alias -- because the seed
   script runs under plain node, outside Next's module resolution. Dates are
   plain day offsets; whoever renders them owns the formatting. */

export const SAMPLE_DOCS = [

      {
        id: 'f1',
        name: 'Personal statement, draft 4',
        kind: 'Common App',
        daysAgo: 3,
        body: `# Personal statement

*Common App. Draft 4, polish only.*

The tide pool was the size of a dinner plate and it had been there longer than the parking lot above it. I know that because I counted the barnacle layers once, badly, with a ruler I had borrowed from my brother.

## What changed

For two years I ran the survey the same way every Saturday:

- six sites, north to south, always in the same order
- water temperature first, because it drifts while you work
- **species count last**, when your eyes have adjusted

The third summer I found out the county had been collecting the same numbers since 1994 and had never once published them. That was the year the project stopped being about tide pools.

> The data was not missing. It was just nowhere anyone could reach it.

## Where it goes

I am not going to write that I fell in love with marine biology in a tide pool. I fell in love with the part nobody photographs: the spreadsheet, the argument with the county clerk, the second chapter opening in October because a seventeen year old asked twice.`,
      },
      {
        id: 'f2',
        name: '“Why Duke”, draft 2',
        kind: 'Supplemental',
        daysAgo: 5,
        body: `# Why Duke

*Supplemental, 150 words. Draft 2. Line edits from this week are in.*

Duke is the only school on my list where the marine lab is not a semester away from the engineering I want to pair it with. The Duke Marine Lab runs **Fall at Beaufort** while the Pratt School keeps me on a coastal engineering sequence, and the two are the same degree rather than a compromise between them.

I want to work with the Bass Connections coastal resilience team. My Coastal Cleanup chapters have three years of species counts that no county office has ever published, which is a data set that wants a research team more than it wants another volunteer Saturday.

---

*Note to self: cut "which is a data set that wants" if it reads precious.*`,
      },
      {
        id: 'f3',
        name: 'UC essay 1, draft 3',
        kind: 'UC',
        daysAgo: 9,
        body: `# Personal insight question 1

*Leadership. 350 words. Draft 3.*

The second chapter almost did not happen. Not because nobody wanted it, but because I had written the founding document as though the only person who would ever read it was me.

## The rewrite

| Version | Problem | Fix |
| --- | --- | --- |
| Charter v1 | Assumed I ran every survey | Named a site lead per school |
| Charter v2 | No handover if a lead graduates | Added a spring training month |
| Charter v3 | Still called it "my" project | It is not |

Leading turned out to mean writing myself out of the document.`,
      },
      {
        id: 'f4',
        name: 'Activities list, final',
        kind: 'Common App',
        daysAgo: 16,
        body: `# Activities list

*Ten slots, ordered by weight rather than by hours.*

1. **Coastal Cleanup Initiative** — founder and lead, three schools
2. **Tide pool biodiversity paper** — accepted, regional symposium
3. **Varsity track** — team captain, third season
4. **Peer tutoring, chemistry** — 120 hours logged
5. Marine Biology Seminar — regional symposium credit

Slots 6 to 10 are the ones we cut down to a line each. Hours are accurate to the week, not rounded up.`,
      },
      {
        id: 'f5',
        name: 'Résumé',
        monthOf: 23,
        kind: 'Shared',
        daysAgo: 23,
        body: `# Maya Ellison

Northwood High School, class of 2027

## Research

**Tide pool biodiversity across six coastal sites** Accepted, regional symposium. Three years of weekly species counts.

## Leadership

**Coastal Cleanup Initiative**, founder and lead Chartered across three schools. Second chapter opening in October.

## Coursework

Seven AP courses, five in the last two years. Fourth year of Spanish.`,
      },
      {
        id: 'f6',
        name: 'SAT score report',
        kind: 'Testing',
        daysAgo: 31,
        body: `# SAT, superscored

**1470** on file.

| Section | March | June | Superscore |
| --- | --- | --- | --- |
| Reading and Writing | 710 | 730 | **730** |
| Math | 720 | 740 | **740** |

No third sitting. The time goes to essays instead.`,
      },
    ];
