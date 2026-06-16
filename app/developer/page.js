import { auth } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';
import { DEVELOPER_EMAIL } from '@/lib/developerAuth';

// /developer (old bookmark) → the tabbed dev portal, Reports first.
export default async function DeveloperPage() {
  const { sessionClaims } = await auth();
  if (sessionClaims?.email !== DEVELOPER_EMAIL) {
    redirect('/dashboard');
  }
  redirect('/developer/reports');
}
