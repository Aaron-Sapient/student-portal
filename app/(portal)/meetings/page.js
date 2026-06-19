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

// Soft role pill that sits beside a name (e.g. "Primary Reader" / "Secondary
// Reader"). Reuses the "Beta" pill recipe from homeSections — including its
// optical-centering for all-caps tracked text — colored to its card's accent.
function RoleTag({ label, tone }) {
  const skin =
    tone === 'gold'
      ? 'bg-ochre/[0.14] text-ochre'
      : 'bg-terracotta/[0.1] text-terracotta-deep';
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-full px-2.5 py-1 text-[9px] font-bold uppercase tracking-[0.12em] ${skin}`}
    >
      <span className="-mr-[0.12em] translate-y-[0.5px] leading-none">{label}</span>
    </span>
  );
}

// Bookable vs locked must read at a glance: bookable rows carry the brand icon
// tile, a FILLED terracotta "Book →" pill, and lift; locked rows are pressed-in,
// grayed, and lead with the padlock. Checked-in rows are a third state — a
// raised confirmation with a moss pill, nothing lock-like about it.
function OptionCard({ href, icon: Icon, name, role, state, loading, delay, accent, tag }) {
  const done = !!state.checkedIn;
  const gold = accent === 'gold';
  const inner = (
    <>
      <IconTile icon={Icon} muted={!state.bookable && !done} tone={gold ? 'gold' : 'terracotta'} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p
            className={`min-w-0 font-display text-xl font-semibold leading-tight ${
              state.bookable || done ? 'text-ink' : 'text-ink-soft'
            }`}
          >
            {name}
          </p>
          {tag && <RoleTag label={tag.label} tone={tag.tone} />}
        </div>
        <p className={`mt-0.5 text-sm ${gold ? 'font-medium text-ochre' : 'text-ink-soft'}`}>{role}</p>
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
  const ring = gold ? ' ring-1 ring-inset ring-ochre/35' : '';
  if (state.bookable) {
    return (
      <Link
        href={href}
        style={{ animationDelay: `${delay}ms` }}
        className={`${base}${ring} group neu-raised transition-transform active:scale-[0.99]`}
      >
        {inner}
      </Link>
    );
  }
  if (done) {
    return (
      <div style={{ animationDelay: `${delay}ms` }} className={`${base}${ring} neu-raised`}>
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

// ── Senior essay-program booking ─────────────────────────────────────────────
// Seniors don't see the Ryan/Aaron/ART check-in cards. Their cadence is
// deterministic: a weekly check-in grants one week's worth of meetings, bookable
// across this + next Saturday-week. When that window includes their phase week
// they also get the once-a-month cross-meeting with the OTHER teacher (bookable
// any day in the window; one slot is reserved so it can't be crowded out). The
// shared booking plan (server-side data.senior) is the single source the calendar
// also reads, so the card and the calendar can never disagree — each meeting card
// shows the date range it's actually bookable in.
const teacherIcon = (slug) => (slug === 'ryan' ? GraduationCap : Trophy);
const lenLabel = (durs) =>
  durs.length === 1 ? `${durs[0]}-min Zoom` : `${durs.join('/')}-min Zoom`;

// "Jun 20–26", or "Jun 27 – Jul 2" across a month boundary.
function fmtRange(startISO, endISO) {
  const a = DateTime.fromISO(startISO, { zone: ZONE });
  const b = DateTime.fromISO(endISO, { zone: ZONE });
  if (!a.isValid || !b.isValid) return '';
  return a.month === b.month
    ? `${a.toFormat('LLL d')}–${b.toFormat('d')}`
    : `${a.toFormat('LLL d')} – ${b.toFormat('LLL d')}`;
}

function SeniorBanner({ s }) {
  const range = s.thisWeek ? fmtRange(s.thisWeek.start, s.thisWeek.end) : '';
  const names = (s.meetings || []).map((m) => m.name);
  const headline = names.length === 0 ? 'You’re all set' : `Meet ${names.join(' & ')}`;
  return (
    <section className="portal-rise neu-raised rounded-[2rem] p-5" style={{ animationDelay: '40ms' }}>
      <div className="flex items-baseline justify-between gap-3">
        <Eyebrow>This week{range ? ` · ${range}` : ''}</Eyebrow>
        <span className="text-[11px] font-semibold text-ink-soft">{s.packageLabel}</span>
      </div>
      <p className="mt-2 font-display text-xl font-semibold leading-tight text-ink">
        {names.length === 0 ? headline : (
          <>Meet <span className="text-terracotta">{names.join(' & ')}</span></>
        )}
      </p>
      <p className="mt-1 text-sm text-ink-soft">{s.packageNote}</p>
      {s.crossOwed && (
        <p className="mt-2.5 inline-flex items-center gap-1.5 rounded-full bg-ochre/[0.12] px-3 py-1 text-[11px] font-semibold text-ochre">
          <span className="h-1.5 w-1.5 rounded-full bg-ochre" />
          Monthly cross-meeting with {s.secondaryName}
        </p>
      )}
      <p className="mt-2 text-xs font-semibold uppercase tracking-[0.1em] text-ink-faint">
        {s.remaining} meeting{s.remaining === 1 ? '' : 's'} left this check-in
      </p>
    </section>
  );
}

function SeniorBookSection({ data, loading }) {
  const s = data.senior;

  // Gate 1 — the weekly check-in must be in before anything is bookable.
  if (!s.checkedIn) {
    return (
      <div className="space-y-7">
        <SeniorBanner s={s} />
        <Link
          href="/check-ins"
          style={{ animationDelay: '110ms' }}
          className="portal-rise group neu-raised flex items-center gap-4 rounded-3xl p-5 transition-transform active:scale-[0.99]"
        >
          <IconTile icon={Lock} muted />
          <div className="min-w-0 flex-1">
            <p className="font-display text-xl font-semibold leading-tight text-ink">Check in to unlock</p>
            <p className="mt-0.5 text-sm text-ink-soft">Your weekly check-in unlocks this week’s meetings.</p>
          </div>
          <ChevronRight className="h-5 w-5 shrink-0 text-ink-faint transition-transform group-hover:translate-x-0.5" strokeWidth={2.2} />
        </Link>
      </div>
    );
  }

  // One card per bookable meeting, each tagged with the window it's bookable in.
  const cards = (s.meetings || []).map((m) => ({
    slug: m.slug,
    name: m.name,
    kind: m.kind,
    role:
      (m.kind === 'cross' ? 'Monthly cross-meeting' : 'Your teacher') +
      (m.window ? ` · ${fmtRange(m.window.start, m.window.end)}` : ''),
    durations: m.durations,
  }));

  return (
    <div className="space-y-7">
      <SeniorBanner s={s} />
      <section className="space-y-3.5">
        <p
          className="portal-rise px-1 text-xs font-semibold uppercase tracking-[0.13em] text-ink-faint"
          style={{ animationDelay: '70ms' }}
        >
          {cards.length > 1 ? 'Book your meetings' : 'Book your meeting'}
        </p>
        {cards.length === 0 ? (
          <OptionCard
            icon={teacherIcon(s.primarySlug)}
            name="You’re all set"
            role="All your meetings for this check-in are booked"
            state={{ checkedIn: true, note: 'Nothing left to book' }}
            loading={loading}
            delay={110}
          />
        ) : (
          cards.map((c, i) => (
            <OptionCard
              key={c.slug}
              href={`/meetings/${c.slug}`}
              icon={teacherIcon(c.slug)}
              name={c.name}
              role={c.role}
              state={{ bookable: true, label: lenLabel(c.durations) }}
              loading={loading}
              delay={110 + i * 60}
              accent={c.kind === 'cross' ? 'gold' : undefined}
              tag={{
                label: c.kind === 'cross' ? 'Secondary Reader' : 'Primary Reader',
                tone: c.kind === 'cross' ? 'gold' : 'primary',
              }}
            />
          ))
        )}
      </section>
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
        ) : data?.senior ? (
          <SeniorBookSection data={data} loading={loading} />
        ) : (
          <BookSection data={data} loading={loading} />
        )}
      </div>

      {/* Cadence record — visible under either section. */}
      <SessionsCard sessions={data?.sessions} />
    </div>
  );
}
