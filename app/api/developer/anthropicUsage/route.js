import { DateTime } from 'luxon';
import { requireDeveloper } from '@/lib/developerAuth';

// Anthropic Admin API: org-level cost reporting. Requires an admin key
// (separate from ANTHROPIC_API_KEY). The endpoint itself is free to query;
// only model inference is billed.
// Docs: https://docs.anthropic.com/en/api/admin-api/usage-cost/get-cost-report
const COST_ENDPOINT = 'https://api.anthropic.com/v1/organizations/cost_report';

async function fetchCostSince(adminKey, startingAt) {
  const url = `${COST_ENDPOINT}?starting_at=${encodeURIComponent(startingAt)}`;
  const res = await fetch(url, {
    headers: {
      'x-api-key': adminKey,
      'anthropic-version': '2023-06-01',
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  // Sum cost across all buckets and result rows. The response shape is
  // { data: [{ results: [{ cost_usd, ... }, ...] }, ...] }; we tolerate
  // either `cost_usd` or a nested `amount` field for forward compatibility.
  let total = 0;
  for (const bucket of json.data || []) {
    for (const row of bucket.results || []) {
      const v = typeof row.cost_usd === 'number' ? row.cost_usd
        : typeof row.amount === 'number' ? row.amount
        : Number(row.cost_usd ?? row.amount ?? 0);
      if (!Number.isNaN(v)) total += v;
    }
  }
  return total;
}

export async function GET() {
  const gate = await requireDeveloper();
  if (!gate.ok) return gate.response;

  const adminKey = process.env.ANTHROPIC_ADMIN_KEY;
  if (!adminKey) {
    return Response.json({ enabled: false, reason: 'ANTHROPIC_ADMIN_KEY not set' });
  }

  try {
    const now = DateTime.utc();
    const startOfDay = now.startOf('day').toISO();
    const startOfMonth = now.startOf('month').toISO();

    const [today, month] = await Promise.all([
      fetchCostSince(adminKey, startOfDay),
      fetchCostSince(adminKey, startOfMonth),
    ]);

    return Response.json({
      enabled: true,
      today,
      month,
      asOf: now.toISO(),
    });
  } catch (err) {
    console.error('anthropicUsage error:', err);
    return Response.json({ enabled: false, reason: err.message || 'Fetch failed' });
  }
}
