import { redirect } from 'next/navigation';

// /dev → the combined Scoring view (the layout has already gated by ADMIN_EMAILS).
export default function DevIndexPage() {
  redirect('/dev/scoring');
}
