import { redirect } from 'next/navigation';

// Deprecated slug. The student home now lives at /dashboard (the link students
// already had bookmarked), so /home just forwards there. Safe to delete once
// we're sure nothing links to /home anymore.
export default function HomeRedirect() {
  redirect('/dashboard');
}
