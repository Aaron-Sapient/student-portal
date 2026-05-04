import { auth } from '@clerk/nextjs/server';

export const DEVELOPER_EMAIL = process.env.DEVELOPER_EMAIL || 'aaron@sapientacademy.com';

export async function requireDeveloper() {
  const { sessionClaims } = await auth();
  const email = sessionClaims?.email;
  if (email !== DEVELOPER_EMAIL) {
    return { ok: false, response: Response.json({ error: 'Forbidden' }, { status: 403 }) };
  }
  return { ok: true, email };
}
