import { requireAdmin } from '@/lib/developerAuth'
import { getQuote, readPricing, markQuoteProvisioned } from '@/lib/pricing'
import { buildContract } from '@/lib/packageContract'
import { provisionFamily } from '@/lib/provisioning'

// POST /api/developer/packageQuotes/<id>/provision — the lead→student bridge.
//
// Body: { tier, studentEmail, parentEmails?: [..], commit?: false }
//
// Given a saved quote and the tier the family accepted, this (a) derives the
// contract payload — the committed deliverables the proposal promised — and
// (b) idempotently creates the family's Clerk identities (dry-run unless
// commit:true, mirroring the provisioning scripts' safe-by-default posture).
// On commit it stamps the receipt onto the quote row (provision jsonb +
// provisioned_at) so the ledger records which quotes became students.
//
// Passwords for newly created accounts appear ONLY in this response — they are
// deliberately not stored in the receipt. Deliver them, or converge later via
// scripts/provisionStudentAccounts.cjs once the Master Sheet row exists.
//
// Admin-gated (Aaron + Ryan), same as the rest of the packages surface.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(request, { params }) {
  const gate = await requireAdmin()
  if (!gate.ok) return gate.response

  const { id } = await params
  if (!UUID_RE.test(String(id || ''))) {
    return Response.json({ error: 'Invalid quote id' }, { status: 400 })
  }

  try {
    const body = await request.json()
    const { tier, studentEmail, parentEmails, commit } = body || {}

    const quote = await getQuote(id)
    if (!quote) return Response.json({ error: 'Quote not found' }, { status: 404 })

    const config = await readPricing()
    const contract = buildContract(quote, config)

    if (!contract.offered.includes(tier)) {
      return Response.json(
        { error: `Tier "${tier}" was not offered in this proposal (offered: ${contract.offered.join(', ')})` },
        { status: 400 }
      )
    }

    const result = await provisionFamily({
      studentEmail,
      parentEmails: Array.isArray(parentEmails) ? parentEmails : [],
      commit: commit === true,
    })

    const accepted = { tier, ...contract.tiers[tier] }

    // The receipt records that the family's identities exist — so it is only
    // written when they all do. A commit with any errored account returns the
    // per-account outcomes and NO stamp; created accounts (and their
    // passwords) still reach the response, and the rerun after fixing the
    // failure converges via ensureUser's idempotency (adversarial-review
    // finding, 2026-08-11).
    if (commit === true && !result.allOk) {
      return Response.json({
        success: false,
        committed: false,
        error: 'One or more accounts failed — receipt not stamped; fix and re-provision',
        contract,
        accepted,
        ...result,
      }, { status: 502 })
    }

    if (commit === true) {
      const receipt = {
        tier,
        studentEmail: String(studentEmail || '').trim().toLowerCase(),
        parentEmails: (Array.isArray(parentEmails) ? parentEmails : []).map((e) => String(e || '').trim().toLowerCase()),
        // account outcomes minus any password — credentials never land in the DB
        accounts: result.accounts.map(({ password, ...rest }) => rest),
        contract: accepted,
        provisionedBy: gate.email,
      }
      await markQuoteProvisioned(id, receipt)
    }

    return Response.json({
      success: true,
      committed: commit === true,
      contract,
      accepted,
      ...result,
    })
  } catch (err) {
    console.error('packageQuotes provision error:', err)
    return Response.json({ error: err.message || 'Server error' }, { status: 500 })
  }
}
