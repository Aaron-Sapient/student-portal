// Bearer-secret gate for cron routes.
//
// Vercel Cron invokes the route with `Authorization: Bearer $CRON_SECRET`; anything
// else (a public GET, a stray request) is rejected. Mirrors the { ok, response }
// shape of requireDeveloper()/requireAdmin() in lib/developerAuth.js so route
// handlers guard the same way.
export function requireCron(request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    // Fail closed: with no secret configured the route must never run.
    return { ok: false, response: Response.json({ error: 'CRON_SECRET not configured' }, { status: 503 }) };
  }
  const header = request.headers.get('authorization') || '';
  if (header !== `Bearer ${secret}`) {
    return { ok: false, response: Response.json({ error: 'Unauthorized' }, { status: 401 }) };
  }
  return { ok: true };
}
