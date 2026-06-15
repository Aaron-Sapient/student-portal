'use client';

import Link from 'next/link';
import { useState } from 'react';
import {
  GraduationCap,
  Trophy,
  FlaskConical,
  ChevronRight,
  Video,
  Plus,
  Lock,
  CheckCircle2,
} from 'lucide-react';
import { DateTime } from 'luxon';
import { usePortalData } from '../PortalDataContext';
import { ZONE, hasBookingAvailable, checkedInThisWeek } from '../portalUtils';
import { ClayCam, Eyebrow, IconTile, SectionDial, WeekBars } from '../neu';
import UpcomingMeeting from '../UpcomingMeeting';

// Resolve a single option's bookable state from the cached portal data.
// checkedIn: the week's check-in is done and no meeting is owed — render a
// confirmation, never the "check in to unlock" padlock.
function ryanState(data) {
  const t = data?.meetingType;
  if (t === '15min' || t === '30min') return { bookable: true, label: t === '15min' ? '15-min Zoom' : '30-min Zoom' };
  if (t === 'written') return { bookable: false, checkedIn: true, note: 'Written update on the way' };
  if (t === 'pending') return { bookable: false, checkedIn: true, note: 'Ryan is reviewing your check-in' };
  if (checkedInThisWeek(data?.lastCheckin))
    return { bookable: false, checkedIn: true, note: 'You’re checked in for this week!' };
  return { bookable: false, note: 'Check in to unlock' };
}
function aaronState(data) {
  const t = data?.aaronMeetingType;
  if (t === '15min' || t === '30min') return { bookable: true, label: t === '15min' ? '15-min Zoom' : '30-min Zoom' };
  if (t === 'email') return { bookable: false, checkedIn: true, note: 'Email follow-up this week' };
  if (checkedInThisWeek(data?.aaronLastCheckin))
    return { bookable: false, checkedIn: true, note: 'You’re checked in for this week!' };
  return { bookable: false, note: 'Check in to unlock' };
}
function artState(data) {
  if (!data?.isART) return null; // not on the team → hide the option entirely
  if (data.artTokenAvailable) return { bookable: true, label: '15-min Zoom' };
  return { bookable: false, note: 'Booked this week' };
}

// Bookable vs locked must read at a glance: bookable rows carry the brand icon
// tile, a FILLED terracotta "Book →" pill, and lift; locked rows are pressed-in,
// grayed, and lead with the padlock. Checked-in rows are a third state — a
// raised confirmation with a moss pill, nothing lock-like about it.
function OptionCard({ href, icon: Icon, name, role, state, loading, delay }) {
  const done = !!state.checkedIn;
  const inner = (
    <>
      <IconTile icon={Icon} muted={!state.bookable && !done} />
      <div className="min-w-0 flex-1">
        <p
          className={`font-display text-xl font-semibold leading-tight ${
            state.bookable || done ? 'text-ink' : 'text-ink-soft'
          }`}
        >
          {name}
        </p>
        <p className="mt-0.5 text-sm text-ink-soft">{role}</p>
        {!loading && (
          <span
            className={`mt-2 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] ${
              state.bookable
                ? 'bg-terracotta font-bold text-paper'
                : done
                ? 'bg-moss/[0.12] font-semibold text-moss'
                : 'bg-sand/50 font-semibold text-ink-faint'
            }`}
          >
            {state.bookable ? (
              <>
                <Video className="h-3.5 w-3.5" strokeWidth={2.4} />
                Book {state.label} →
              </>
            ) : (
              <>
                {done || state.note === 'Booked this week' ? (
                  <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={2.4} />
                ) : (
                  <Lock className="h-3 w-3" strokeWidth={2.6} />
                )}
                {state.note}
              </>
            )}
          </span>
        )}
      </div>
      {state.bookable && (
        <ChevronRight className="h-5 w-5 shrink-0 text-ink-faint transition-transform group-hover:translate-x-0.5" strokeWidth={2.2} />
      )}
    </>
  );

  const base = 'portal-rise flex items-center gap-4 rounded-3xl p-5';
  if (state.bookable) {
    return (
      <Link
        href={href}
        style={{ animationDelay: `${delay}ms` }}
        className={`${base} group neu-raised transition-transform active:scale-[0.99]`}
      >
        {inner}
      </Link>
    );
  }
  if (done) {
    return (
      <div style={{ animationDelay: `${delay}ms` }} className={`${base} neu-raised`}>
        {inner}
      </div>
    );
  }
  // Locked options read as pressed-in — physically "not liftable".
  return (
    <div
      style={{ animationDelay: `${delay}ms` }}
      className={`${base} neu-inset opacity-75`}
      aria-disabled
    >
      {inner}
    </div>
  );
}

function BookSection({ data, loading }) {
  const ryan = ryanState(data);
  const aaron = aaronState(data);
  const art = artState(data);

  return (
    <div className="space-y-7">
      <section className="space-y-3.5">
        <p
          className="portal-rise px-1 text-xs font-semibold uppercase tracking-[0.13em] text-ink-faint"
          style={{ animationDelay: '70ms' }}
        >
          Who do you want to meet with?
        </p>
        <OptionCard
          href="/meetings/ryan"
          icon={GraduationCap}
          name="Ryan"
          role="Counseling & academics"
          state={ryan}
          loading={loading}
          delay={110}
        />
        <OptionCard
          href="/meetings/aaron"
          icon={Trophy}
          name="Aaron"
          role="Competitions & projects"
          state={aaron}
          loading={loading}
          delay={170}
        />
        {art && (
          <OptionCard
            href="/meetings/art"
            icon={FlaskConical}
            name="ART"
            role="Advanced Research Team · with Aaron"
            state={art}
            loading={loading}
            delay={230}
          />
        )}
      </section>

      {!loading &&
        !ryan.bookable &&
        !aaron.bookable &&
        !(art && art.bookable) &&
        !ryan.checkedIn &&
        !aaron.checkedIn && (
          <p className="portal-rise text-center text-sm text-ink-soft" style={{ animationDelay: '270ms' }}>
            Nothing to book yet — complete a weekly check-in to unlock a meeting.
          </p>
        )}
    </div>
  );
}

// Session frequency, one bar per week — moved here from Home: meeting cadence
// belongs with meetings (info-once rule).
function SessionsCard({ sessions }) {
  if (!sessions || sessions.length === 0) return null;
  const total = sessions.reduce((a, w) => a + w.count, 0);
  const firstMonth = DateTime.fromISO(sessions[0].week, { zone: ZONE }).toFormat('LLL');
  return (
    <section
      className="portal-rise neu-raised rounded-[2rem] p-5"
      style={{ animationDelay: '320ms' }}
    >
      <div className="flex items-baseline justify-between gap-3">
        <Eyebrow>Sessions</Eyebrow>
        <span className="text-[11px] font-medium text-ink-soft">
          <span className="font-display text-xl font-bold leading-none text-terracotta">
            {total}
          </span>{' '}
          in 12 weeks
        </span>
      </div>
      {/* peaks sit *in* the clay: flush to the well floor, rounded crowns only */}
      <div className="neu-inset mt-3.5 overflow-hidden rounded-2xl px-3 pt-3.5">
        <WeekBars weeks={sessions} />
      </div>
      <div className="mt-1.5 flex justify-between px-1 text-[9px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
        <span>{firstMonth}</span>
        <span>this week</span>
      </div>
      {total === 0 && (
        <p className="mt-2.5 text-xs leading-relaxed text-ink-soft">
          Your meetings will chart here as they happen.
        </p>
      )}
    </section>
  );
}

function UpcomingSection({ meetings, studentName }) {
  return (
    <div className="space-y-3.5">
      {meetings.map((m, i) => (
        <div key={m.id} className="portal-rise" style={{ animationDelay: `${70 + Math.min(i, 6) * 55}ms` }}>
          <UpcomingMeeting meeting={m} studentName={studentName} isNext={i === 0} />
        </div>
      ))}
    </div>
  );
}

const SECTIONS = [
  { key: 'upcoming', label: 'Upcoming', icon: Video },
  { key: 'book', label: 'Book', icon: Plus },
];

export default function MeetingsPage() {
  const { data, meetings, loading } = usePortalData();

  // The user's explicit dial choice; until they pick, the default is derived:
  // a bookable token steers to Book, otherwise an existing meeting to Upcoming.
  const [picked, setPicked] = useState(null);
  const hasUpcoming = meetings.length > 0;
  const defaultSection =
    !loading && !hasBookingAvailable(data) && hasUpcoming ? 'upcoming' : 'book';
  // If the last meeting is cancelled the dial disappears — fall back to Book.
  const section = hasUpcoming ? picked ?? defaultSection : 'book';

  return (
    <div className="space-y-7">
      <header className="portal-rise flex items-center gap-4 sm:gap-5" style={{ animationDelay: '0ms' }}>
        <ClayCam scale={1.25} />
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-ink-faint">
            Zoom sessions
          </p>
          <h1 className="mt-1.5 font-display text-[2rem] font-semibold leading-[1.08] tracking-tight text-ink sm:text-[2.6rem] sm:leading-[1.05]">
            Book &amp; view<br />{' '}<span className="text-terracotta">meetings.</span>
          </h1>
        </div>
      </header>

      {/* The dial exists only when there's something upcoming to switch to. */}
      {hasUpcoming && (
        <div className="portal-rise" style={{ animationDelay: '40ms' }}>
          <SectionDial sections={SECTIONS} value={section} onChange={setPicked} />
        </div>
      )}

      <div key={section}>
        {section === 'upcoming' ? (
          <UpcomingSection meetings={meetings} studentName={data?.studentName} />
        ) : (
          <BookSection data={data} loading={loading} />
        )}
      </div>

      {/* Cadence record — visible under either section. */}
      <SessionsCard sessions={data?.sessions} />
    </div>
  );
}
