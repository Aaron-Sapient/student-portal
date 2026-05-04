import { auth } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';
import { DEVELOPER_EMAIL } from '@/lib/developerAuth';
import DeveloperDashboard from './DeveloperDashboard';

export default async function DeveloperPage() {
  const { sessionClaims } = await auth();
  if (sessionClaims?.email !== DEVELOPER_EMAIL) {
    redirect('/dashboard');
  }
  return <DeveloperDashboard />;
}
