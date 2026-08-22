import { auth } from '@clerk/nextjs/server';

export const DEVELOPER_EMAIL = process.env.DEVELOPER_EMAIL || 'aaron@sapientacademy.com';

// The simplified /dev scoring surface admits Ryan too; the full /developer
// portal and its non-scoring routes stay developer-only. All three addresses
// are Ryan's — he shouldn't have to care which account he's signed into
// (Clerk users provisioned 2026-08-11 via scripts/provisionAdminAccounts.cjs).
export const ADMIN_EMAILS = [
  DEVELOPER_EMAIL,
  'ryan@sapientacademy.com',
  'choiryan@gmail.com',
  'ryan@ryanchoice.com',
];

// Which instructor a staff session IS, as the 📆 Meetings log spells it
// (`teacher` = 'Aaron' | 'Ryan'; home-data buckets anything that isn't 'ryan'
// as Aaron, so an unmapped address must refuse rather than default). All three
// Ryan addresses map to Ryan — the old writingAuth name lookup returned 'Admin'
// for two of them.
export const TEACHER_BY_EMAIL = {
  [DEVELOPER_EMAIL]: 'Aaron',
  'ryan@sapientacademy.com': 'Ryan',
  'choiryan@gmail.com': 'Ryan',
  'ryan@ryanchoice.com': 'Ryan',
};
export const teacherForEmail = (email) => TEACHER_BY_EMAIL[String(email ?? '').trim().toLowerCase()] ?? null;

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
