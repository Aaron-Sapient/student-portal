// Verbatim proposal-email copy, ported from the auto-generator sheet's Backend +
// Output tabs (10quV4-…, captured 2026-06-15). Client-safe (no imports). The
// dynamic per-package lines (services / bonuses / discounts / totals) are
// assembled in lib/packageEmail.js from the calculator; this module holds the
// static and lightly-interpolated text blocks.
//
// Wording is preserved as Ryan wrote it (em dashes, curly quotes, etc.). A few
// clear sheet bugs are corrected and flagged where they occur:
//   • pronouns now follow the student's gender (the sheet hardcoded "her"/"she"
//     inside the early-start paragraph regardless of gender);
//   • "{first}gets" missing space is fixed;
//   • the early-start paragraph and the grade-9 "10th-grade program" line now
//     use the student's actual grade (the sheet hardcoded "10th").

export function pronouns(gender) {
  const male = String(gender || '').toLowerCase() === 'male'
  return { subj: male ? 'he' : 'she', poss: male ? 'his' : 'her', obj: male ? 'him' : 'her' }
}

// Month → seasonal bonus name (Backend W/X).
export const MONTH_BONUS = {
  January: 'Beginning-of-Year',
  February: 'Beginning-of-Year',
  March: 'Start-of-Spring',
  April: 'Early-Bird',
  May: 'AP-Season',
  June: 'Start-of-Summer',
  July: 'Summer',
  August: 'End-of-Summer',
  September: 'Back-to-School',
  October: 'Fall',
  November: 'Thanksgiving',
  December: 'End-of-Year',
}

// "Why starting now matters" intro bullets, per grade (Backend G2:G5, the part
// before the conditional early-start paragraph).
export const WHY_NOW_BULLETS = {
  '9':
    'Starting now matters because the foundation you build sets the tone for everything that follows:\n' +
    '- Early academic habits, course choices, and GPA trajectory are established now: strong habits prevent later scrambling.\n' +
    '- Exploring interests, clubs, and extracurriculars early allows time to discover passions and develop leadership naturally.\n' +
    '- Building relationships with teachers, mentors, and peers early pays off for guidance, recommendations, and opportunities.\n' +
    '- Understanding academic expectations and testing prep early reduces stress later and gives you a clear path forward.\n' +
    '- Laying the groundwork for long-term planning ensures sophomore and junior years are strategic, not reactive.',
  '10':
    'Starting now matters because this is the time to solidify direction and build measurable achievements:\n' +
    '- Course performance now affects class rank, GPA, and future college competitiveness—don’t let momentum slip.\n' +
    '- Early testing prep (PSAT, AP planning) ensures you stay ahead of deadlines and benchmarks.\n' +
    '- Leadership and extracurricular depth begin now—take initiative in clubs, teams, and projects to stand out later.\n' +
    '- Summer plans and early experience in research, internships, or programs need proactive preparation.\n' +
    '- Strategic planning now allows you to target senior-year opportunities, avoiding last-minute pressure.',
  '11':
    'Starting now matters because the timeline compresses quickly:\n' +
    '- It’s not too late, but the window is closing quickly, so we need to move with urgency now.\n' +
    '- Testing and score planning should be locked in and executed ASAP to prevent a stressful, last-minute fall.\n' +
    '- Summer programs, research, internships, and projects require early planning plus real action (outreach, applications, and follow-through).\n' +
    '- This semester’s grades, exams, and major assessments need maximum preparation and the right support system in place to protect GPA and performance.\n' +
    '- Junior-year course strategy, GPA protection, and leadership depth must be managed intentionally.\n' +
    '- The goal is to enter senior fall with clarity, strong assets, and momentum, not scrambling.',
  '12':
    'Starting now matters because the clock is short and every action impacts final results:\n' +
    '- College applications, essays, and supplemental materials must be polished with attention to detail—delaying increases stress and decreases quality.\n' +
    '- Standardized testing, if still needed, must be finalized promptly to avoid last-minute conflicts.\n' +
    '- Leadership, awards, and project highlights should be showcased clearly in real time for applications.\n' +
    '- Maintaining strong academics through final exams, APs, and GPA tracking is crucial; no room for late lapses.\n' +
    '- Senior-year decisions—college visits, scholarships, and postsecondary planning—require immediate clarity and follow-through.',
}

// Early-start paragraph appended to "Why now" when the early-start window
// applies (Menu!D26). `vipBonusText` is the $-value when paired with VIP.
export function earlyStartParagraph({ first, grade, gender }, vipBonusText) {
  const p = pronouns(gender)
  return (
    `Officially, our ${grade}th-grade counseling program begins in early September. However, if ${first} enrolls by 4/27, ` +
    `we will start working with ${p.obj} immediately at the ${grade}th-grade package price, with no additional charge for the ` +
    `months between now and the official September start. This means ${first} gets, at no extra cost:\n` +
    ` - Full counseling support from now through early September (approximately 4 to 5 months of active advising, check-ins, and planning)\n` +
    `Combined, this can add up to ${vipBonusText} in additional service (when paired with VIP).`
  )
}

// Season accomplishments, by grade then season (Backend B:D). Grade 12 only has
// summer/fall in the sheet.
export const SEASON_ACCOMPLISH = {
  '9': {
    summer:
      '- Build a four-year course-load plan, accounting for intended major and academic rigor\n' +
      '- Preliminary college-fit brainstorm + why\n' +
      '- Begin long-term volunteering and personal development projects early (for Congressional Award)',
    fall:
      '- Join (or continue) 1–2 ECs with leadership and impact potential\n' +
      '- Establish strong academic systems (tutoring and self-study) to excel in core subjects\n' +
      '- Create a starting-point (running) résumé and LinkedIn',
    winter:
      '- Apply to summer camps, programs, or enrichment opportunities (most deadlines fall Jan–March)\n' +
      '- Begin converting extracurricular experiences into "origin stories" for passion and engagement\n' +
      '- Evaluate first-semester performance and adjust academic/extracurricular strategy as needed',
    spring:
      '- Position for leadership, advancement, or responsibility within current activities\n' +
      '- Finalize summer plans to include activities that build laterally transferrable skills and narrative continuity\n' +
      '- Assess for competition-readiness and eligibility for advanced research, projects, or internships',
  },
  '10': {
    summer:
      '- Build skills or depth through camps, solo or group projects (if eligible), volunteering, or structured learning\n' +
      '- Solidify 10th-grade course load and begin light academic previewing to enter 10th grade strong\n' +
      '- Reflect on interests and passions to refine direction\n' +
      '- Maintain volunteering continuity',
    fall:
      '- Carefully monitor increased academic rigor (APs + honors)\n' +
      '- Take on tangible leadership, ownership, and/or responsbility\n' +
      '- Continue solo passion project or group project (if eligible)\n' +
      '- Introductory test prep (vocab, fundamental mechanics, etc)',
    winter:
      '- Apply to summer camps, research programs, internships, and/or selective opportunities\n' +
      '- Review transcript trajectory and intensify AP/finals support if needed\n' +
      '- Start identifying potential competition, research, or internship opportunities (if eligible)\n' +
      '- Continue solo or group project (if eligible)',
    spring:
      '- Demonstrate strong rigor across APs and honors\n' +
      '- Finalize summer plans\n' +
      '- Build a comprehensive 11th-grade blueprint with step-by-step actions and a clear execution plan\n' +
      '- Create a competition roadmap with clear submission targets and checkpoints',
  },
  '11': {
    summer:
      '- Lock in every major test and exam timeline now (SAT and school/AP assessments), including prep and practice milestones\n' +
      '- Pursue engagement continuity through summer program, solo or group project, or internship opportunities (if eligible)\n' +
      '- Pursue major-related competitions and/or academic research beyond the classroom (if eligible)',
    fall:
      '- Execute standardized testing plan with discipline and clear score targets\n' +
      '- Solidify leadership roles and measurable impact in core activities\n' +
      '- Begin early college research with realistic academic and financial framing',
    winter:
      '- Apply to summer camps, research programs, internships, and selective opportunities\n' +
      '- Finalize testing attempts and contingency plans\n' +
      '- Begin outlining personal narrative themes and potential essay angles',
    spring:
      '- Confirm recommenders and strengthen teacher relationships\n' +
      '- Begin discussions for college list framework (fit and target/reach/safety logic)\n' +
      '- Plan a summer that meaningfully advances the application narrative',
  },
  '12': {
    summer:
      '- Begin big-picture application items like the Common App main essay\n' +
      '- Build preliminary college list for fit and reach\n' +
      '- Pursue "wow factor" through top-level summer program, solo or group project, or internship opportunities (if eligible)\n' +
      '- Pursue highly prestigious competitions and/or academic research beyond the classroom (if eligible)',
    fall:
      '- Finalize and submit applications with attention to quality, not just deadlines\n' +
      '- Manage interview prep and supplemental essays efficiently\n' +
      '- Maintain academic performance: senior-year drops still matter',
  },
}

// Fixed "Included services for X" lists (Output B19/B30/B41 — static).
export const PACKAGE_INCLUDED = {
  essential:
    ' - Meetings: Monthly 1 to 1\n' +
    ' - Academic Blueprint: Four year course plan\n' +
    ' - Activity Planning: Basic activity map\n' +
    ' - Summer Planning: Recommendation list\n' +
    ' - Monitoring & Accountability: Monthly accountability\n' +
    ' - College List: Strategy for 5 schools\n' +
    ' - Common App Support: Idea, outline, 1 full review\n' +
    ' - Supplements (5 schools): 1 round of comments\n' +
    ' - Essay Turnaround: Standard\n' +
    ' - Parent Communication: Email with boundaries\n' +
    ' - Waitlist & Appeals: Not included',
  comprehensive:
    ' - Meetings: Biweekly 1 to 1\n' +
    ' - Academic Blueprint: Full academic and testing plan\n' +
    ' - Activity Planning: Leadership development plan\n' +
    ' - Summer Planning: Curated shortlist of options\n' +
    ' - Monitoring & Accountability: Biweekly accountability\n' +
    ' - College List: Strategy & refinement for 5 schools\n' +
    ' - Common App Support: Full development (2–3 drafts)\n' +
    ' - Supplements (5 schools): Up to 2 rounds per essay\n' +
    ' - Essay Turnaround: Faster\n' +
    ' - Parent Communication: 1 update per semester\n' +
    ' - Waitlist & Appeals: Not included',
  vip:
    ' - Meetings: Weekly 1 to 1\n' +
    ' - Academic Blueprint: Competitive academic strategy for target schools\n' +
    ' - Activity Planning: Advanced leadership and project planning\n' +
    ' - Summer Planning: Fully customized competitive summer strategy\n' +
    ' - Monitoring & Accountability: Weekly accountability w/ task tracking\n' +
    ' - College List: Deeper refinement & targeting for 5 schools\n' +
    ' - Common App Support: Integrated into weekly meetings (several drafts)\n' +
    ' - Supplements (5 schools): Multiple rounds integrated weekly\n' +
    ' - Essay Turnaround: Priority\n' +
    ' - Parent Communication: Flexible strategy access\n' +
    ' - Waitlist & Appeals: Included (5 schools)',
}

// "Best for:" line per package (Output B26/B37/B48). Essential interpolates name.
export function bestFor(pkg, { first }) {
  if (pkg === 'essential')
    return ` - Families who want strong structure and clear direction, with ${first} handling more independent execution.`
  if (pkg === 'comprehensive')
    return ' -  Families who want balanced support, stronger accountability, and more hands-on planning.'
  return ' - Families who want maximum engagement and proactive oversight, with the most customization and execution support.'
}

// Timeline "Academic Counseling" blurb, per grade (Backend H2:H5).
export function academicCounseling({ first, grade, gender }) {
  const p = pronouns(gender)
  if (grade === '9')
    return `Ongoing guidance to help ${first} explore academic interests, build strong foundations, and develop effective habits early.`
  if (grade === '10')
    return `Ongoing guidance to help ${first} refine academic interests, make intentional course and activity choices, and begin shaping a coherent profile.`
  if (grade === '12')
    return 'In 12th grade, our primary focus is on college application assistance (see below).'
  // grade 11 (default)
  return `Ongoing guidance to keep ${first} aligned academically and strategically while ${p.subj} builds ${p.poss} profile.`
}

// "Do we need to pick a major now?" answer (Output B79).
export function majorFaq({ grade }) {
  return `Not immediately. During ${grade}th grade, we intentionally narrow and refine academic direction, with the goal of solidifying intended majors as early as possible so that applications are cohesive and strategic.`
}

// "What if interests change?" answer, per grade (Backend M2:M5).
export function interestsFaq({ first, grade, gender }) {
  const p = pronouns(gender)
  if (grade === '9')
    return `That is completely normal. In 9th grade, interests are expected to evolve, and this is the ideal time to explore broadly. We will prioritize curiosity, skill-building, and low-risk experimentation so ${first} can discover genuine academic interests without locking into a narrow path too early.`
  if (grade === '10')
    return `In 10th grade, students are still allowed meaningful flexibility, but emerging interests should begin translating into early coursework choices, activities, or summer plans so ${first} can start forming a credible academic narrative.`
  if (grade === '12')
    return `By 12th grade, significant changes in intended major are limited. While reframing interests is still possible through essay positioning and school-specific strategy, the academic record and activities are largely set, so any shift must align clearly with what ${first} has already demonstrated to admissions readers.`
  return `That is normal. Minor pivots are still possible in 11th grade, but core academic direction, projects, and competitions must be solidified as soon as possible so ${first}'s profile remains coherent, credible, and competitive for ${p.poss} target schools.`
}

// Service descriptions for "What key services mean" (Backend Z/[ 13:19). Keyed
// by a logical service group; shown only when that group is selected anywhere.
export function serviceDescription(group, { first }) {
  switch (group) {
    case 'competitions':
      return 'Competitions: We identify best-fit competitions, manage timelines, brainstorm strong angles, mentor execution, and ensure submissions are completed on time and at a high standard'
    case 'internship':
      return 'Internship & Research (Search-Only): We help build a resume and LinkedIn profile, then guide outreach to organizations open to high school talent'
    case 'soloProject':
      return `Solo Passion Project: We custom-build a solo project to align with ${first}'s academic interests and be highly differentiating`
    case 'groupProject':
      return 'Group Project: Built for 3–5 like-minded students to start or join and take on an important role'
    case 'groupSat':
      return 'Group SAT Course: Synchronous rigorous group classes designed to help students succeed at SAT English and math'
    case 'oneOnOneSat':
      return '1:1 SAT: Intensive one-on-one SAT lessons to sharpen strategies and raise scores in the least time possible'
    case 'apTutoring':
      return 'AP Tutoring: One-on-one AP subject tutoring intended to boost AP scores and GPA'
    default:
      return ''
  }
}

// Static blocks (Output, verbatim).
export const STATIC = {
  whyNowHeading: 'Why starting now matters',
  bonusIntro: 'These bonuses are tied to your specific package selection:',
  pricingConfirmation: 'Pricing confirmation',
  discountsLead: 'These totals already include the following discounts:',
  packageDetails: 'Package Details',
  packageDetailsBody: 'For more information about our packages, please visit https://www.admissions.partners/packages',
  customHeading: 'Prefer a custom plan instead of a package? (new this year)',
  customLink: 'You can build your own package here: https://admissionspartners.vercel.app/partnership',
  importantNote: 'Important Note',
  zoomOffer: 'If helpful, we can schedule a short Zoom call to select services together and finalize quickly.',
  timelineHeading: 'Timeline: How services kick in over time',
  acHeading: 'Academic Counseling (now through 11th grade)',
  caaHeading: 'College Application Assistance (end of 11th through 12th grade)',
  caaBody:
    'Application work begins toward the end of 11th grade into 12th grade. At that point, it replaces Academic Counseling, so our focus shifts fully to school strategy, essays, finalization, and submission.',
  servicesHeading: 'What key services mean',
  commonQuestions: 'Common questions',
  faqQ1: '1. What do "extra colleges" mean?',
  faqA1:
    'All packages start with five schools, and more can be added. Reserving extra schools now secures future application capacity so planning stays predictable. Application execution typically begins near the end of 11th grade into 12th grade.',
  faqQ2: '2. Do we need to pick a major now?',
  faqQ4: '4. Can we upgrade our package later?',
  faqA4:
    'Sometimes, but not always. Upgrades depend on remaining capacity and scope availability within the grade-level cohort. Because counseling slots are capped and often fill early, we strongly recommend reserving the appropriate level of college support upfront. Once our quota is reached, upgrades are no longer available. Any upgrades, if available, are priced at the rates in effect at that time.',
  paymentOptions: 'Payment Options',
  paymentStep1: 'Step 1: Reply with one of the following:',
  customReply: '- Or reply “Custom” to schedule a short Zoom call and build the right plan together.',
  paymentTerms: 'Payment terms',
  paymentTermsBody:
    'By enrolling, you agree to pay the full program fee regardless of participation, engagement, or completion of services. Because admissions counseling is front-loaded and much of the work happens early, payments are structured to support full commitment from the start.',
  payInFullHeading: 'Pay-in-full incentive (Comprehensive and VIP)',
  payInFullBody:
    'If paid in full upfront, A|P may apply a one-time incentive of $500 for programs priced at $25,000 or less, or $1,000 for programs priced above $25,000.',
  step2Heading: 'Step 2: Share DocuSign',
  step2Body: 'We will send a one-page DocuSign agreement confirming the selected services, payment, and our terms and conditions.',
  step3Heading: 'Step 3: Sign DocuSign',
  step3Body: 'You will e-sign the DocuSign.',
  step4Heading: 'Step 4: Stripe Payment',
  step4Body: 'We will send a Stripe payment link.',
  step5Heading: 'Step 5: Onboarding',
  forYourReference: 'For your reference',
  termsLabel: 'Terms and conditions (must be accepted to onboard):',
  termsLink: 'https://admissionspartners.vercel.app/terms',
  servicesListLabel: 'Services list and details',
  servicesListLink: 'https://admissionspartners.vercel.app/partnership',
  thanks: 'Thank you for your interest in our counseling services. Please let me know if you have any questions.',
  signOff: 'Warm regards,',
  signature: 'Admissions Partners Care Team',
}
