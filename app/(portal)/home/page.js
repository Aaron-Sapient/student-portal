'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { DateTime } from 'luxon';
import {
  ArrowUpRight,
  CalendarClock,
  CheckCircle2,
  CircleAlert,
  Flag,
  MessageSquare,
  Sparkles,
} from 'lucide-react';

const ZONE = 'America/Los_Angeles';

/* ── Date helpers (Luxon, pinned to LA to avoid Vercel-UTC off-by-one) ──── */

// Google Sheets hands us either a serial number (days since 1899-12-30) or a
// string. Pin both to the LA *calendar date* so display never drifts a day.
function parseSheetDate(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') {
    const utc = DateTime.fromMillis(Math.round((raw - 25569) * 86400 * 1000), { zone: 'utc' });
    if (!utc.isValid) return null;
    return DateTime.fromObject({ year: utc.year, month: utc.month, day: utc.day }, { zone: ZONE });
  }
  let dt = DateTime.fromISO(String(raw), { zone: ZONE });
  if (!dt.isValid) dt = DateTime.fromJSDate(new Date(raw)).setZone(ZONE);
  return dt.isValid ? dt : null;
}

function startOfThisWeek() {
  const now = DateTime.now().setZone(ZONE);
  let sat = now.set({ weekday: 6 });
  if (now.weekday < 6) sat = sat.minus({ weeks: 1 });
  return sat.startOf('day');
}

function checkedInThisWeek(raw) {
  const dt = parseSheetDate(raw);
  return !!dt && dt >= startOfThisWeek();
}

function daysUntil(dt) {
  const now = DateTime.now().setZone(ZONE).startOf('day');
  return Math.round(dt.startOf('day').diff(now, 'days').days);
}

function relativeLabel(days) {
  if (days < 0) return 'past due';
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days <= 7) return `in ${days} days`;
  return `in ${Math.round(days / 7)} wk${days >= 14 ? 's' : ''}`;
}

function bookingHref(instructor, type) {
  const t = type === '30min' ? '30' : type === '15min' ? '15' : null;
  return t ? `/booking?instructor=${instructor}&type=${t}` : null;
}

/* ── Presentational pieces ──────────────────────────────────────────────── */

function StatusPill({ label, done }) {
  return (
    <div
      className={`flex items-center gap-2 rounded-2xl border px-3.5 py-3 ${
        done
          ? 'border-moss/25 bg-moss/[0.07]'
          : 'border-terracotta/25 bg-clay-50'
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

function ActionRow({ href, children }) {
  return (
    <Link
      href={href}
      className="group flex items-center justify-between gap-3 rounded-2xl bg-ink px-4 py-3.5 text-cream shadow-card transition-transform active:scale-[0.99]"
    >
      <span className="text-sm font-semibold">{children}</span>
      <ArrowUpRight
        className="h-4 w-4 shrink-0 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
        strokeWidth={2.4}
      />
    </Link>
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
  const cls =
    'block h-full rounded-3xl border border-sand bg-cream-dim/60 p-5 shadow-card';
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
      <div className="portal-skeleton h-[58px] rounded-2xl" />
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="portal-skeleton h-[132px] rounded-3xl" />
        <div className="portal-skeleton h-[132px] rounded-3xl" />
      </div>
      <div className="portal-skeleton h-[92px] rounded-3xl" />
    </div>
  );
}

/* ── Page ───────────────────────────────────────────────────────────────── */

export default function HomePage() {
  const [data, setData] = useState(null);
  const [meeting, setMeeting] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    Promise.all([
      fetch('/api/home-data').then((r) => r.json()),
      fetch('/api/getUpcomingMeetings').then((r) => r.json()).catch(() => ({})),
    ])
      .then(([home, meetings]) => {
        if (!alive) return;
        if (home?.error) {
          setError(home.error);
        } else {
          setData(home);
          setMeeting(meetings?.meetings?.[0] || null);
        }
        setLoading(false);
      })
      .catch(() => {
        if (!alive) return;
        setError('We couldn’t load your portal. Pull to refresh or try again shortly.');
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

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

  const ryanBook = bookingHref('ryan', data.meetingType);
  const aaronBook = bookingHref('aaron', data.aaronMeetingType);
  const artBook = data.isART && data.artTokenAvailable ? '/booking?instructor=art&type=15' : null;

  // Soonest upcoming project = the student's "next deadline".
  const nextDeadline = (data.activeProjects || [])
    .map((p) => ({ ...p, dt: parseSheetDate(p.endDate) }))
    .filter((p) => p.dt)
    .sort((a, b) => a.dt - b.dt)[0];

  const meetingDt = meeting?.start
    ? DateTime.fromISO(meeting.start, { zone: ZONE })
    : null;

  return (
    <div className="space-y-7">
      {/* Greeting */}
      <header className="portal-rise" style={{ animationDelay: '0ms' }}>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-ink-faint">
          {today}
        </p>
        <h1 className="mt-1.5 font-display text-[2.6rem] font-semibold leading-[1.05] tracking-tight text-ink">
          Welcome back,
          <br />
          <span className="text-terracotta">{first}.</span>
        </h1>
      </header>

      {/* Check-in status */}
      <section className="portal-rise" style={{ animationDelay: '70ms' }}>
        <div className="grid grid-cols-2 gap-3">
          <StatusPill label="Ryan check-in" done={ryanDone} />
          <StatusPill label="Aaron check-in" done={aaronDone} />
        </div>
      </section>

      {/* Actions: only render the ones the student can actually act on */}
      {(ryanBook || aaronBook || artBook) && (
        <section className="portal-rise space-y-2.5" style={{ animationDelay: '140ms' }}>
          {ryanBook && (
            <ActionRow href={ryanBook}>
              Book your {data.meetingType} with Ryan
            </ActionRow>
          )}
          {aaronBook && (
            <ActionRow href={aaronBook}>
              Book your {data.aaronMeetingType} with Aaron
            </ActionRow>
          )}
          {artBook && (
            <ActionRow href={artBook}>
              <span className="inline-flex items-center gap-1.5">
                <Sparkles className="h-4 w-4" strokeWidth={2.2} />
                Book your ART meeting
              </span>
            </ActionRow>
          )}
        </section>
      )}

      {/* At-a-glance: next deadline + next meeting */}
      <section className="portal-rise grid gap-3 sm:grid-cols-2" style={{ animationDelay: '210ms' }}>
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
            meta="Book one above when you’re ready."
          />
        )}
      </section>

      {/* Message your instructor */}
      <section className="portal-rise" style={{ animationDelay: '280ms' }}>
        <Link
          href="/message"
          className="group flex items-center gap-4 rounded-3xl border border-terracotta/30 bg-gradient-to-br from-clay-50 to-cream-dim p-5 shadow-card transition-shadow hover:shadow-lift"
        >
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-terracotta text-cream shadow-sm">
            <MessageSquare className="h-5 w-5" strokeWidth={2.2} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-display text-base font-semibold text-ink">
              Message Aaron or Ryan
            </span>
            <span className="block text-sm text-ink-soft">
              Stuck on something? Send a quick note.
            </span>
          </span>
          <ArrowUpRight
            className="h-5 w-5 shrink-0 text-terracotta transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
            strokeWidth={2.2}
          />
        </Link>
      </section>
    </div>
  );
}
