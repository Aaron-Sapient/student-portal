import { requireAdmin } from '@/lib/developerAuth'
import { readPricing, writePricing } from '@/lib/pricing'
import { validatePricing } from '@/lib/pricingSchema'

// GET → the active pricing config (defaults merged with the stored row). POST →
// validate + upsert. Admin-gated (Aaron + Ryan), same as the scoring routes.
// Backed by Supabase (lib/pricing); a missing table just yields defaults on GET.

export async function GET() {
  const gate = await requireAdmin()
  if (!gate.ok) return gate.response

  try {
    const config = await readPricing()
    return Response.json({ config })
  } catch (err) {
    console.error('pricing GET error:', err)
    return Response.json({ error: err.message || 'Server error' }, { status: 500 })
  }
}

export async function POST(request) {
  const gate = await requireAdmin()
  if (!gate.ok) return gate.response

  try {
    const { config } = await request.json()
    const invalid = validatePricing(config)
    if (invalid) return Response.json({ error: invalid }, { status: 400 })

    await writePricing(config, gate.email)
    return Response.json({ success: true })
  } catch (err) {
    console.error('pricing POST error:', err)
    return Response.json({ error: err.message || 'Server error' }, { status: 500 })
  }
}
