import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import AaronCheckIn from '../AaronCheckIn';

export default function AaronCheckInPage() {
  return (
    <div>
      <Link
        href="/check-ins"
        className="mb-4 inline-flex items-center gap-1 text-sm font-semibold text-ink-soft transition hover:text-ink"
      >
        <ChevronLeft className="h-4 w-4" strokeWidth={2.4} />
        Check-ins
      </Link>
      <AaronCheckIn />
    </div>
  );
}
