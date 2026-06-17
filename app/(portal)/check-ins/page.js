'use client';

import Link from 'next/link';
import { GraduationCap, Trophy, CheckCircle2, ChevronRight, Circle } from 'lucide-react';
import { usePortalData } from '../PortalDataContext';
import { checkedInThisWeek } from '../portalUtils';
import { ClayCheck, IconTile } from '../neu';

function PersonCard({ href, icon: Icon, name, role, done, loading, delay }) {
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
                Checked in
              </>
            ) : (
              <>
                <Circle className="h-3.5 w-3.5" strokeWidth={2.4} />
                Check-in available
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

export default function CheckInsPage() {
  const { data, loading } = usePortalData();
  const ryanDone = checkedInThisWeek(data?.lastCheckin);
  const aaronDone = checkedInThisWeek(data?.aaronLastCheckin);
  const isSenior = !!data?.senior;

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
            done={data?.senior?.checkedIn}
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
    </div>
  );
}
