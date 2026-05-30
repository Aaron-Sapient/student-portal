'use client';

import Link from 'next/link';
import { DateTime } from 'luxon';
import { CalendarClock, CheckCircle2, CircleAlert, Flag } from 'lucide-react';
import { usePortalData } from '../PortalDataContext';
import CoachCard from '../CoachCard';
import { ZONE, parseSheetDate, checkedInThisWeek, daysUntil, relativeLabel } from '../portalUtils';

/* ── Presentational pieces ──────────────────────────────────────────────── */

function StatusPill({ label, done }) {
  return (
    <div
      className={`flex items-center gap-2 rounded-2xl border px-3.5 py-3 ${
        done ? 'border-moss/25 bg-moss/[0.07]' : 'border-terracotta/25 bg-clay-50'
      }`}
    >
      {done ? (
        <CheckCircle2 className="h-5 w-5 shrink-0 text-moss" strokeWidth={2.2} />
      ) : (
        <CircleAlert className="h-5 w-5 shrink-0 text-terracotta" strokeWidth={2.2} />
      )}
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-ink">{label}</p>
        <p className={`text-xs font-medium ${done ? 'text-moss' : 'text-terracotta-deep'}`}>
          {done ? 'Checked in' : 'Due this week'}
        </p>
      </div>
    </div>
  );
}

function InfoCard({ icon: Icon, eyebrow, title, meta, accent, href }) {
  const body = (
    <>
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-terracotta" strokeWidth={2.2} />
        <span className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-soft">
          {eyebrow}
        </span>
      </div>
      <p className="mt-3 font-display text-lg font-semibold leading-snug text-ink">{title}</p>
      {meta && (
        <p className="mt-1 text-sm text-ink-soft">
          {meta}
          {accent && <span className="font-semibold text-terracotta-deep"> · {accent}</span>}
        </p>
      )}
    </>
  );
  const cls = 'block h-full rounded-3xl border border-sand bg-cream-dim/60 p-5 shadow-card';
  return href ? (
    <Link href={href} className={`${cls} transition-shadow hover:shadow-lift`}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

function Skeleton() {
  return (
    <div className="space-y-7">
      <div>
        <div className="portal-skeleton h-3 w-40 rounded-full" />
        <div className="portal-skeleton mt-3 h-11 w-64 rounded-2xl" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="portal-skeleton h-[68px] rounded-2xl" />
        <div className="portal-skeleton h-[68px] rounded-2xl" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="portal-skeleton h-[132px] rounded-3xl" />
        <div className="portal-skeleton h-[132px] rounded-3xl" />
      </div>
    </div>
  );
}

/* ── Page ───────────────────────────────────────────────────────────────── */

export default function HomePage() {
  const { data, meeting, coach, loading, error } = usePortalData();

  if (loading) return <Skeleton />;

  if (error) {
    return (
      <div className="portal-rise mt-10 rounded-3xl border border-terracotta/25 bg-clay-50 p-6 text-center">
        <CircleAlert className="mx-auto h-7 w-7 text-terracotta" strokeWidth={2} />
        <p className="mt-3 font-display text-lg font-semibold text-ink">Something’s off</p>
        <p className="mt-1 text-sm text-ink-soft">{error}</p>
      </div>
    );
  }

  const first = (data.studentName || '').trim().split(' ')[0] || 'there';
  const today = DateTime.now().setZone(ZONE).toFormat('cccc, LLLL d');

  const ryanDone = checkedInThisWeek(data.lastCheckin);
  const aaronDone = checkedInThisWeek(data.aaronLastCheckin);

  // Soonest upcoming project = the student's "next deadline".
  const nextDeadline = (data.activeProjects || [])
    .map((p) => ({ ...p, dt: parseSheetDate(p.endDate) }))
    .filter((p) => p.dt)
    .sort((a, b) => a.dt - b.dt)[0];

  const meetingDt = meeting?.start ? DateTime.fromISO(meeting.start, { zone: ZONE }) : null;

  return (
    <div className="space-y-7">
      {/* Greeting */}
      <header className="portal-rise" style={{ animationDelay: '0ms' }}>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-ink-faint">{today}</p>
        <h1 className="mt-1.5 font-display text-[2.6rem] font-semibold leading-[1.05] tracking-tight text-ink">
          Welcome back,
          <br />
          <span className="text-terracotta">{first}.</span>
        </h1>
      </header>

      {/* Claude Coach — warm, time-sensitive note (shows only when present) */}
      <CoachCard coach={coach} />

      {/* Check-in status — display only; the Check-Ins tab is the pathway */}
      <section className="portal-rise" style={{ animationDelay: '70ms' }}>
        <div className="grid grid-cols-2 gap-3">
          <StatusPill label="Ryan check-in" done={ryanDone} />
          <StatusPill label="Aaron check-in" done={aaronDone} />
        </div>
      </section>

      {/* At-a-glance: next deadline + next meeting */}
      <section className="portal-rise grid gap-3 sm:grid-cols-2" style={{ animationDelay: '140ms' }}>
        {nextDeadline ? (
          <InfoCard
            icon={Flag}
            eyebrow="Next deadline"
            title={nextDeadline.name || 'Untitled project'}
            meta={nextDeadline.dt.toFormat('ccc, LLL d')}
            accent={relativeLabel(daysUntil(nextDeadline.dt))}
            href={nextDeadline.link || undefined}
          />
        ) : (
          <InfoCard
            icon={Flag}
            eyebrow="Next deadline"
            title="Nothing due soon"
            meta="Good time to plan ahead."
          />
        )}

        {meetingDt ? (
          <InfoCard
            icon={CalendarClock}
            eyebrow="Next meeting"
            title={`${meeting.instructor || 'Meeting'} · ${meetingDt.toFormat('h:mm a')}`}
            meta={meetingDt.toFormat('cccc, LLL d')}
            accent={relativeLabel(daysUntil(meetingDt))}
          />
        ) : (
          <InfoCard
            icon={CalendarClock}
            eyebrow="Next meeting"
            title="No meetings booked"
            meta="Book one from the tab below."
          />
        )}
      </section>
    </div>
  );
}
