'use client'
import { useEffect, useState } from 'react';
import UpdateForm from '@/components/UpdateForm';
import AaronUpdateForm from '@/components/AaronUpdateForm';
import UpcomingMeetings from '@/components/UpcomingMeetings';
import Link from 'next/link';
import { DateTime } from 'luxon';

function getNextSaturdayDate() {
  return DateTime.now()
    .setZone('America/Los_Angeles')
    .set({ weekday: 6 })
    .plus(DateTime.now().weekday >= 6 ? { weeks: 1 } : {})
    .toLocaleString({ month: 'long', day: 'numeric' });
}

function formatCheckinDate(rawValue) {
  if (!rawValue) return null;

  let date;
  if (typeof rawValue === 'number') {
    date = new Date((rawValue - 25569) * 86400 * 1000);
  } else {
    date = new Date(rawValue);
  }

  if (isNaN(date)) return null;

  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

function getCheckinColor(rawValue) {
  if (!rawValue) return '#e00000';
  let date;
  if (typeof rawValue === 'number') {
    date = new Date((rawValue - 25569) * 86400 * 1000);
  } else {
    date = new Date(rawValue);
  }
  if (isNaN(date)) return '#e00000';

  const now = new Date();
  const day = now.getDay();
  const diff = (day + 1) % 7;
  const saturday = new Date(now);
  saturday.setHours(0, 0, 0, 0);
  saturday.setDate(now.getDate() - diff);

  return date >= saturday ? '#C6613F' : '#e00000';
}

function CheckinSubtitle({ lastCheckin, instructorTitle }) {
  if (!lastCheckin) {
    return <>Please fill this out to have a meeting with {instructorTitle}</>;
  }

  const lastCheckinDate = typeof lastCheckin === 'number'
    ? DateTime.fromMillis((lastCheckin - 25569) * 86400 * 1000).setZone('America/Los_Angeles')
    : DateTime.fromISO(lastCheckin).setZone('America/Los_Angeles');

  const now = DateTime.now().setZone('America/Los_Angeles');
  let startOfThisWeek = now.set({ weekday: 6 });
  if (now.weekday < 6) {
    startOfThisWeek = startOfThisWeek.minus({ weeks: 1 });
  }
  startOfThisWeek = startOfThisWeek.startOf('day');

  if (lastCheckinDate >= startOfThisWeek) {
    return (
      <>
        Thanks for checking in! Your check-in form will re-open{' '}
        <span style={{ color: '#C6613F' }}>
          Saturday, {getNextSaturdayDate()}
        </span>.
      </>
    );
  }

  return <>Please fill out your check-in form to have a meeting with {instructorTitle}</>;
}

export default function Dashboard() {
  const [studentName, setStudentName] = useState('');
  const [lastCheckin, setLastCheckin] = useState(null);
  const [meetingType, setMeetingType] = useState(null);
  const [aaronLastCheckin, setAaronLastCheckin] = useState(null);
  const [aaronMeetingType, setAaronMeetingType] = useState(null);
  const [isART, setIsART] = useState(false);
  const [artTokenAvailable, setArtTokenAvailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch('/api/home-data')
      .then(res => res.json())
      .then(data => {
        if (data.error) setError(data.error);
        else {
          setStudentName(data.studentName || '');
          setLastCheckin(data.lastCheckin || null);
          setMeetingType(data.meetingType || null);
          setAaronLastCheckin(data.aaronLastCheckin || null);
          setAaronMeetingType(data.aaronMeetingType || null);
          setIsART(!!data.isART);
          setArtTokenAvailable(!!data.artTokenAvailable);
        }
        setLoading(false);
      })
      .catch(() => {
        setError('Failed to load data');
        setLoading(false);
      });
  }, []);

  const ryanCheckinDateStr = formatCheckinDate(lastCheckin);
  const ryanCheckinColor = getCheckinColor(lastCheckin);
  const ryanBookingUrl = meetingType === '30min' ? '/booking?instructor=ryan&type=30' :
                         meetingType === '15min' ? '/booking?instructor=ryan&type=15' : null;

  const aaronCheckinDateStr = formatCheckinDate(aaronLastCheckin);
  const aaronCheckinColor = getCheckinColor(aaronLastCheckin);
  const aaronBookingUrl = aaronMeetingType === '30min' ? '/booking?instructor=aaron&type=30' :
                          aaronMeetingType === '15min' ? '/booking?instructor=aaron&type=15' : null;

  return (
    <div style={{ backgroundColor: '#FAF9F4', minHeight: '100vh', width: '100%' }}>
      <main style={{ padding: '2rem', maxWidth: '720px', margin: '0 auto' }}>

        <h1 style={{
          fontSize: '18px',
          fontWeight: '100',
          color: '#353535',
          fontFamily: "'DM Sans', 'Poppins', sans-serif",
        }}>
          {'Admissions.Partners | Student Dashboard'}
        </h1>

        <h1 style={{
          fontSize: '45px',
          fontWeight: '700',
          marginBottom: '0.5rem',
          color: '#111',
          fontFamily: "'DM Sans', 'Poppins', sans-serif",
        }}>
          {studentName ? `Welcome, ${studentName.split(' ')[0]}` : 'My Dashboard'}
        </h1>

        <nav style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: '0.6rem',
          marginBottom: '2rem',
          fontFamily: "'DM Sans', 'Poppins', sans-serif",
          fontSize: '14px',
          fontWeight: '600',
        }}>
          {[
            { label: 'Ryan Check-In', href: '#ryan-checkin' },
            { label: 'Aaron Check-In', href: '#aaron-checkin' },
            { label: 'Upcoming Meetings', href: '#upcoming-meetings' },
            ...(isART ? [{ label: 'ART', href: '#art-meeting' }] : []),
          ].map((item, i, arr) => (
            <span key={item.href} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.6rem' }}>
              <a href={item.href} className="dashboard-nav-link" style={{
                color: '#3c3c3c',
                textDecoration: 'none',
                transition: 'color 0.15s ease',
              }}>
                {item.label}
              </a>
              {i < arr.length - 1 && <span style={{ color: '#B4B3B0' }}>|</span>}
            </span>
          ))}
        </nav>

        <style>{`.dashboard-nav-link:hover { color: #C6613F !important; }`}</style>

        {/* Container: Ryan Check-in + Booking */}
        <section id="ryan-checkin" style={{ marginBottom: '2rem' }}>
          <h2 style={{
            fontSize: '30px',
            fontWeight: '700',
            marginBottom: '0.4rem',
            color: '#111',
            fontFamily: "'DM Sans', 'Poppins', sans-serif",
          }}>
            Weekly Check-in with Ryan
          </h2>

          <h3 style={{
            fontSize: '14px',
            fontStyle: 'italic',
            fontWeight: '700',
            color: '#3c3c3c',
            fontFamily: "'DM Sans', 'Poppins', sans-serif",
          }}>
            <CheckinSubtitle lastCheckin={lastCheckin} instructorTitle="Director Ryan" />
          </h3>

          {ryanBookingUrl && (
            <div style={{ marginTop: '1rem', marginBottom: '1rem' }}>
              <Link href={ryanBookingUrl}>
                <button style={{
                  backgroundColor: '#111',
                  color: '#fff',
                  padding: '10px 20px',
                  borderRadius: '8px',
                  border: 'none',
                  fontWeight: '600',
                  cursor: 'pointer',
                  fontFamily: "'DM Sans', sans-serif"
                }}>
                  Book {meetingType} Meeting with Ryan
                </button>
              </Link>
            </div>
          )}

          <p style={{
            fontSize: '13px',
            fontWeight: '500',
            marginBottom: '1.5rem',
            fontFamily: "'DM Sans', 'Poppins', sans-serif",
            color: ryanCheckinColor,
          }}>
            {ryanCheckinDateStr ? `Your last check-in with Ryan was: ${ryanCheckinDateStr}` : ''}
          </p>

          <UpdateForm />
        </section>

        {/* Container: Aaron Check-in + Booking */}
        <section id="aaron-checkin" style={{ marginBottom: '2rem' }}>
          <h2 style={{
            fontSize: '30px',
            fontWeight: '700',
            marginBottom: '0.4rem',
            color: '#111',
            fontFamily: "'DM Sans', 'Poppins', sans-serif",
          }}>
            Weekly Check-in with Aaron
          </h2>

          <h3 style={{
            fontSize: '14px',
            fontStyle: 'italic',
            fontWeight: '700',
            color: '#3c3c3c',
            fontFamily: "'DM Sans', 'Poppins', sans-serif",
          }}>
            <CheckinSubtitle lastCheckin={aaronLastCheckin} instructorTitle="Aaron" />
          </h3>

          {aaronBookingUrl && (
            <div style={{ marginTop: '1rem', marginBottom: '1rem' }}>
              <Link href={aaronBookingUrl}>
                <button style={{
                  backgroundColor: '#111',
                  color: '#fff',
                  padding: '10px 20px',
                  borderRadius: '8px',
                  border: 'none',
                  fontWeight: '600',
                  cursor: 'pointer',
                  fontFamily: "'DM Sans', sans-serif"
                }}>
                  Book {aaronMeetingType} Meeting with Aaron
                </button>
              </Link>
            </div>
          )}

          <p style={{
            fontSize: '13px',
            fontWeight: '500',
            marginBottom: '1.5rem',
            fontFamily: "'DM Sans', 'Poppins', sans-serif",
            color: aaronCheckinColor,
          }}>
            {aaronCheckinDateStr ? `Your last check-in with Aaron was: ${aaronCheckinDateStr}` : ''}
          </p>

          <AaronUpdateForm />
        </section>

        {/* Container: ART Meeting (only for Advanced Research Team students) */}
        {isART && (
          <section id="art-meeting" style={{ marginBottom: '2rem' }}>
            <h2 style={{
              fontSize: '30px',
              fontWeight: '700',
              marginBottom: '0.4rem',
              color: '#111',
              fontFamily: "'DM Sans', 'Poppins', sans-serif",
            }}>
              ART Meeting
            </h2>

            <h3 style={{
              fontSize: '14px',
              fontStyle: 'italic',
              fontWeight: '700',
              color: '#3c3c3c',
              fontFamily: "'DM Sans', 'Poppins', sans-serif",
            }}>
              {artTokenAvailable
                ? 'You have one 15-minute ART meeting available with Aaron this week.'
                : 'You\'ve already booked your ART meeting this week — see Upcoming Meetings below to reschedule or cancel.'}
            </h3>

            {artTokenAvailable && (
              <div style={{ marginTop: '1rem', marginBottom: '1rem' }}>
                <Link href="/booking?instructor=art&type=15">
                  <button style={{
                    backgroundColor: '#111',
                    color: '#fff',
                    padding: '10px 20px',
                    borderRadius: '8px',
                    border: 'none',
                    fontWeight: '600',
                    cursor: 'pointer',
                    fontFamily: "'DM Sans', sans-serif"
                  }}>
                    Book ART Meeting
                  </button>
                </Link>
              </div>
            )}
          </section>
        )}

        {/* Container: Upcoming Meetings */}
        <section id="upcoming-meetings" style={{ marginBottom: '2rem' }}>
          <UpcomingMeetings studentName={studentName} />
        </section>

      </main>
    </div>
  );
}
