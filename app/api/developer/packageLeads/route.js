import { requireAdmin } from '@/lib/developerAuth'
import { leadsConfigured, listPackageLeads, getPackageLead } from '@/lib/packageLeads'

// GET /api/developer/packageLeads            → recent SuperScore leads as
//                                              builder prefill records
// GET /api/developer/packageLeads?q=<id|email> → one lead (newest row for an
//                                              email — a retaken quiz's latest
//                                              answers are the live ones)
//
// The manual-referral path is simply "don't pass a lead": this endpoint is the
// received-record source, not a gate on building proposals. Unconfigured funnel
// env answers { configured: false } with an empty list rather than erroring, so
// the builder works on machines without funnel access.

export async function GET(request) {
  const gate = await requireAdmin()
  if (!gate.ok) return gate.response

  if (!leadsConfigured()) {
    return Response.json({ configured: false, leads: [], lead: null })
  }

  try {
    const q = new URL(request.url).searchParams.get('q')
    if (q) {
      const lead = await getPackageLead(q)
      return Response.json({ configured: true, lead })
    }
    const leads = await listPackageLeads()
    return Response.json({ configured: true, leads })
  } catch (err) {
    console.error('packageLeads GET error:', err)
    return Response.json({ error: err.message || 'Server error' }, { status: 500 })
  }
}
