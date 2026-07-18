'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Award, GraduationCap, Trophy, CheckCircle2, ChevronRight, Circle } from 'lucide-react';
import { usePortalData } from '../PortalDataContext';
import { checkedInThisWeek } from '../portalUtils';
import { ClayCheck, IconTile } from '../neu';

function PersonCard({
  href,
  icon: Icon,
  name,
  role,
  done,
  loading,
  delay,
  doneLabel = 'Checked in',
  pendingLabel = 'Check-in available',
}) {
  return (
    <Link
      href={href}
      className="portal-rise group neu-raised flex items-center gap-4 rounded-3xl p-5 transition-transform active:scale-[0.99]"
      style={{ animationDelay: `${delay}ms` }}
    >
      <IconTile icon={Icon} />

      <div className="min-w-0 flex-1">
        <p className="font-display text-xl font-semibold leading-tight text-ink">{name}</p>
        <p className="mt-0.5 text-sm text-ink-soft">{role}</p>
        {!loading && (
          <span className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-moss/[0.1] px-2.5 py-1 text-[11px] font-semibold text-moss">
            {done ? (
              <>
                <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={2.4} />
                {doneLabel}
              </>
            ) : (
              <>
                <Circle className="h-3.5 w-3.5" strokeWidth={2.4} />
                {pendingLabel}
              </>
            )}
          </span>
        )}
      </div>

      <ChevronRight
        className="h-5 w-5 shrink-0 text-ink-faint transition-transform group-hover:translate-x-0.5"
        strokeWidth={2.2}
      />
    </Link>
  );
}

// Own lightweight fetch — annual, not part of the shared weekly check-in data
// PortalDataContext carries (mirrors how `coach` gets its own small endpoint).
function useApScoresStatus() {
  const [state, setState] = useState({ loading: true, submittedThisYear: false });
  useEffect(() => {
    let alive = true;
    fetch('/api/apScores')
      .then((r) => r.json())
      .then((data) => {
        if (!alive) return;
        setState({ loading: false, submittedThisYear: !!data?.submittedThisYear });
      })
      .catch(() => {
        if (!alive) return;
        setState({ loading: false, submittedThisYear: false });
      });
    return () => {
      alive = false;
    };
  }, []);
  return state;
}

export default function CheckInsPage() {
  const { data, loading } = usePortalData();
  const ryanDone = checkedInThisWeek(data?.lastCheckin);
  const aaronDone = checkedInThisWeek(data?.aaronLastCheckin);
  const isSenior = !!data?.senior;
  const apScores = useApScoresStatus();

  return (
    <div className="space-y-7">
      <header className="portal-rise flex items-center gap-4 sm:gap-5" style={{ animationDelay: '0ms' }}>
        <ClayCheck scale={1.25} />
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-ink-faint">
            Weekly check-in
          </p>
          <h1 className="mt-1.5 font-display text-[2rem] font-semibold leading-[1.08] tracking-tight text-ink sm:text-[2.6rem] sm:leading-[1.05]">
            Let’s get you<br />{' '}<span className="text-terracotta">checked in.</span>
          </h1>
        </div>
      </header>

      {isSenior ? (
        // Seniors do a SINGLE weekly check-in — it's the prerequisite that unlocks
        // their deterministic booking for the week (no Aaron/Ryan split).
        <section className="space-y-3">
          <PersonCard
            href="/check-ins/senior"
            icon={GraduationCap}
            name="Weekly check-in"
            role="Unlocks this week’s meetings"
            done={data?.senior?.checkedInThisWeek}
            loading={loading}
            delay={80}
          />
        </section>
      ) : (
        <section className="space-y-3">
          <PersonCard
            href="/check-ins/ryan"
            icon={GraduationCap}
            name="Ryan"
            role="Counseling & academics"
            done={ryanDone}
            loading={loading}
            delay={80}
          />
          <PersonCard
            href="/check-ins/aaron"
            icon={Trophy}
            name="Aaron"
            role="Competitions & projects"
            done={aaronDone}
            loading={loading}
            delay={140}
          />
        </section>
      )}

      {/* Once reported, this card disappears entirely rather than lingering as
          a "done" tile for the rest of the year (info-once — a closed-out
          annual task isn't something to keep showing). Hidden while loading
          too, so it never flashes in only to vanish a moment later. */}
      {!apScores.loading && !apScores.submittedThisYear && (
        <section className="space-y-3">
          <PersonCard
            href="/check-ins/ap-scores"
            icon={Award}
            name="AP Scores"
            role="Report this year's exam results"
            done={false}
            loading={false}
            pendingLabel="Report available"
            delay={200}
          />
        </section>
      )}
    </div>
  );
}
