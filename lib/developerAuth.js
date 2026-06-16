import { auth } from '@clerk/nextjs/server';

export const DEVELOPER_EMAIL = process.env.DEVELOPER_EMAIL || 'aaron@sapientacademy.com';

// The simplified /dev scoring surface admits Ryan too; the full /developer
// portal and its non-scoring routes stay developer-only.
export const ADMIN_EMAILS = [DEVELOPER_EMAIL, 'ryan@sapientacademy.com'];

export async function requireDeveloper() {
  const { sessionClaims } = await auth();
  const email = sessionClaims?.email;
  if (email !== DEVELOPER_EMAIL) {
    return { ok: false, response: Response.json({ error: 'Forbidden' }, { status: 403 }) };
  }
  return { ok: true, email };
}

// Gate for the scoring routes shared with /dev.
export async function requireAdmin() {
  const { sessionClaims } = await auth();
  const email = sessionClaims?.email;
  if (!ADMIN_EMAILS.includes(email)) {
    return { ok: false, response: Response.json({ error: 'Forbidden' }, { status: 403 }) };
  }
  return { ok: true, email };
}
