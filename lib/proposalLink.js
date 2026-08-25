// The two clipboard payloads that replace the 1,700-word proposal Gmail: the
// capability URL for a saved proposal, and the ~35-word note Ryan actually
// sends. Client-safe (no Supabase import) so the builder and the Saved panel
// can both reach it, and shared so those two surfaces can never drift into
// sending different links or different wording for the same proposal.
//
// emailBaseUrl() rather than window.location: a link pasted into Gmail outlives
// the tab it was copied from, and a per-deployment *.vercel.app host is exactly
// the kind that Vercel garbage-collects out from under an already-sent email
// (see lib/baseUrl.js).

import { emailBaseUrl } from './baseUrl'
import { countWord, pronouns } from './packageContent'
import { normalizeSelectedPackages } from './pricingSchema'

export function proposalUrl(id) {
  return `${emailBaseUrl()}/proposal/${id}`
}

// Ryan's voice, deliberately under 70 words: the page carries the proposal now,
// so the email's only jobs are to name the student, hand over the link, and say
// what replying does. No meeting offer — the page's own CTA is the reply, and a
// second invitation here competes with it.
export function shortEmailText({ id, firstName, selectedPackages, gender }) {
  const n = normalizeSelectedPackages(selectedPackages).length
  const first = String(firstName || '').trim() || 'there'
  const options = `${countWord(n)} option${n === 1 ? '' : 's'}`
  // Same pronoun source the proposal itself uses, so the note and the page
  // never disagree about the student.
  const them = pronouns(gender).obj
  return [
    `Hi ${first} and family,`,
    '',
    `${first}'s proposal is ready, with ${options} we built for ${them}: ${proposalUrl(id)}`,
    '',
    'Reply with the option you choose, and the next step is a one-page agreement.',
    '',
    'Best,',
    'Ryan',
  ].join('\n')
}
