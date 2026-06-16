import { redirect } from 'next/navigation';

// Bare /parent has no UI of its own — the family portal's first tab is Home.
// Bounce to it so typing /parent never dead-ends (the layout still runs its
// server-side parent role gate first).
export default function ParentIndex() {
  redirect('/parent/home');
}
