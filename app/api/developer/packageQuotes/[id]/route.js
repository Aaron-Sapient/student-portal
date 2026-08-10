import { requireAdmin } from '@/lib/developerAuth';
import { getQuote } from '@/lib/pricing';

// GET /api/developer/packageQuotes/<id> → one saved proposal: the `selection`
// blob and the sent `email_html`, both omitted by the list endpoint.
//
// No consumer yet — the reopen control in the builder is UI and is deliberately
// unbuilt. See lib/pricing.js getQuote for the reason a re-render is NOT
// equivalent to the saved email: buildEmail resolves seasons, late-start and
// early-start against a reference date, so reopening has to decide between
// reproducing the original (pass created_at as refISO) and repricing for today.
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
    return Response.json({ quote });
  } catch (err) {
    console.error('packageQuotes GET one error:', err);
    return Response.json({ error: err.message || 'Server error' }, { status: 500 });
  }
}
