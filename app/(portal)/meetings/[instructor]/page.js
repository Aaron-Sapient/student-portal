import { Suspense } from 'react';
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
    // The booking flow gets its own desktop width: at lg it breaks out of the
    // portal's shared 672px column and centers on the viewport at ~960px so the
    // calendar + times can sit side by side. min(60rem,100vw-3rem) keeps it from
    // ever exceeding the viewport, so no horizontal-scroll artifact. Below lg this
    // is inert and the page stays in the normal 672px flow. Other portal pages are
    // untouched — the width lives here, not in the shared layout.
    <div className="lg:relative lg:left-1/2 lg:w-[min(60rem,100vw-3rem)] lg:-translate-x-1/2">
      <Link
        href="/meetings"
        className="mb-4 inline-flex items-center gap-1 text-sm font-semibold text-ink-soft transition hover:text-ink"
      >
        <ChevronLeft className="h-4 w-4" strokeWidth={2.4} />
        Meetings
      </Link>
      <Suspense
        fallback={
          <div className="portal-rise mx-auto max-w-xl space-y-5">
            <div className="portal-skeleton h-10 w-48 rounded-2xl" />
            <div className="portal-skeleton h-72 rounded-3xl" />
          </div>
        }
      >
        <BookingFlow slug={slug} />
      </Suspense>
    </div>
  );
}
