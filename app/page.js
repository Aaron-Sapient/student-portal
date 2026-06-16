import { redirect } from 'next/navigation'
import { auth } from '@clerk/nextjs/server'
import { getSessionRole } from '@/lib/identity'

export default async function Home() {
  const { userId } = await auth()
  if (!userId) redirect('/sign-in')
  // Parents land in the family portal; everyone else keeps the existing
  // student entry point. Role comes from the session claim (publicMetadata
  // fallback), set by scripts/provisionParentAccounts.cjs.
  const role = await getSessionRole()
  redirect(role === 'parent' ? '/parent/home' : '/dashboard')
}
