import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import BookingFlow from '../BookingFlow';

const VALID = new Set(['ryan', 'aaron', 'art']);

export default async function BookInstructorPage({ params }) {
  const { instructor } = await params;
  const slug = (instructor || '').toLowerCase();
  if (!VALID.has(slug)) notFound();

  return (
    <div>
      <Link
        href="/meetings"
        className="mb-4 inline-flex items-center gap-1 text-sm font-semibold text-ink-soft transition hover:text-ink"
      >
        <ChevronLeft className="h-4 w-4" strokeWidth={2.4} />
        Meetings
      </Link>
      <BookingFlow slug={slug} />
    </div>
  );
}
