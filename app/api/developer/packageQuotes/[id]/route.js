import { requireAdmin } from '@/lib/developerAuth';
import { getQuote, readPricing } from '@/lib/pricing';
import { resolvePricing } from '@/lib/pricingSchema';
import { buildContract } from '@/lib/packageContract';

// GET /api/developer/packageQuotes/<id> → one saved proposal: the `selection`
// blob and the saved `email_html`, both omitted by the list endpoint.
//
// Consumed by the Saved tab's detail panel (app/dev/packages/SavedQuotes.js),
// which resolves the choice lib/pricing.js getQuote describes — a re-render is
// NOT equivalent to the saved email, because buildEmail resolves seasons,
// late-start and early-start against a reference date. The panel takes BOTH
// sides explicitly: it displays `email_html` verbatim as the record, and
// "Open in builder" re-prices `selection` for today, saying so on screen.
// `contract` is returned for provisioning's benefit; the panel ignores it.
//
// Admin-gated (Aaron + Ryan), same as the list/save endpoint beside it.

// package_quotes.id is a uuid (scripts/supabase-pricing-schema.sql). Postgres
// raises on a malformed one, so shape-check first and answer 400 rather than
// letting a bad bookmark surface as a 500.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request, { params }) {
  const gate = await requireAdmin();
  if (!gate.ok) return gate.response;

  const { id } = await params;
  if (!UUID_RE.test(String(id || ''))) {
    return Response.json({ error: 'Invalid quote id' }, { status: 400 });
  }

  try {
    const quote = await getQuote(id);
    if (!quote) return Response.json({ error: 'Not found' }, { status: 404 });
    // The quote read as a commitment: per-tier committed deliverables, derived
    // from the same calculator that priced them (see lib/packageContract.js).
    // The fallback config, used only for a row saved before config_snapshot
    // existed. It follows the row's own preset for the same reason the snapshot
    // does: a legacy-card proposal must not re-derive against today's ladder.
    const contract = buildContract(quote, resolvePricing(quote.selection?.pricingPreset, await readPricing()));
    return Response.json({ quote, contract });
  } catch (err) {
    console.error('packageQuotes GET one error:', err);
    return Response.json({ error: err.message || 'Server error' }, { status: 500 });
  }
}
