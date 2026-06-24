import Link from 'next/link';
import { getSupabaseClient, SAT_QUIZZES } from '@/lib/supabase';

// Quiz home: a grid of clay balls, one per active quiz. Tapping a ball drops the
// student into /sat/<slug>. Server-rendered so the list is current with no client
// fetch / loading flash. Expandable — new rows in sat_quizzes appear here.
export const dynamic = 'force-dynamic';

async function getQuizzes() {
  try {
    const sb = getSupabaseClient();
    const { data } = await sb
      .from(SAT_QUIZZES)
      .select('slug,title,kind')
      .eq('active', true)
      .order('sort_order');
    return data || [];
  } catch (err) {
    console.error('sat home load error:', err);
    return null; // distinguish "failed" from "none yet"
  }
}

function QuizBall({ quiz, index }) {
  return (
    <Link
      href={`/sat/${quiz.slug}`}
      className="portal-rise group neu-raised relative flex aspect-square flex-col items-center justify-center gap-1.5 rounded-full p-6 text-center transition-transform duration-200 active:scale-95"
      style={{ animationDelay: `${120 + index * 70}ms` }}
    >
      {/* Spherical top-left highlight so the raised disc reads as a clay ball. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-full"
        style={{
          background:
            'radial-gradient(58% 52% at 32% 26%, rgba(255,255,255,0.55), transparent 62%)',
        }}
      />
      <span className="relative font-display text-xl font-semibold leading-tight text-ink">
        {quiz.title}
      </span>
      <span className="relative text-[10px] font-bold uppercase tracking-[0.16em] text-terracotta">
        {quiz.kind}
      </span>
    </Link>
  );
}

export default async function SatHome() {
  const quizzes = await getQuizzes();

  return (
    <div>
      <header className="portal-rise mb-8" style={{ animationDelay: '40ms' }}>
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-terracotta">
          Admissions.Partners
        </p>
        <h1 className="mt-1 font-display text-4xl font-semibold leading-tight text-ink">
          SAT Practice
        </h1>
        <p className="mt-2 text-sm text-ink-soft">
          Pick a quiz to begin. You&apos;ll choose your name on the next screen.
        </p>
      </header>

      {quizzes === null ? (
        <div
          className="portal-rise neu-inset rounded-3xl p-6 text-center text-sm text-ink-soft"
          style={{ animationDelay: '120ms' }}
        >
          Couldn&apos;t load the quizzes right now. Please refresh in a moment.
        </div>
      ) : quizzes.length === 0 ? (
        <div
          className="portal-rise neu-inset rounded-3xl p-6 text-center text-sm text-ink-soft"
          style={{ animationDelay: '120ms' }}
        >
          No quizzes are available yet — check back soon.
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-5 sm:grid-cols-3">
          {quizzes.map((quiz, i) => (
            <QuizBall key={quiz.slug} quiz={quiz} index={i} />
          ))}
        </div>
      )}
    </div>
  );
}
