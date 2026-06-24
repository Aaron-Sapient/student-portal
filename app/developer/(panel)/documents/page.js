import { redirect } from 'next/navigation';

// The Docs tab was folded into the Writing tab, which has since been retired from
// /developer — files now live on the unified Students tab. Keep this route as a
// redirect so old bookmarks land in the right place instead of 404ing.
export default function DocumentsPage() {
  redirect('/developer/students');
}
