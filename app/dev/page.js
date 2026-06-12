import { redirect } from 'next/navigation';

// /dev → the Scoring tab (the layout has already gated by ADMIN_EMAILS).
export default function DevIndexPage() {
  redirect('/dev/scoring');
}
