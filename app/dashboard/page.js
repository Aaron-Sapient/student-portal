'use client'
import { useEffect, useState } from 'react';
import UpdateForm from '@/components/UpdateForm';
import UpcomingMeetings from '@/components/UpcomingMeetings';
import { Italic } from 'lucide-react';

function getMostRecentMonday() {
  const now = new Date();
  const day = now.getDay();
  const diff = day === 0 ? 6 : day - 1;
  const monday = new Date(now);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(now.getDate() - diff);
  return monday;
}

function formatCheckinDate(rawValue) {
  if (!rawValue) return null;

  let date;
  if (typeof rawValue === 'number') {
    // Google Sheets serial number
    date = new Date((rawValue - 25569) * 86400 * 1000);
  } else {
    date = new Date(rawValue);
  }

  if (isNaN(date)) return null;

  // Format in user's local timezone: "Wed Apr 8"
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
  const monday = getMostRecentMonday();
  return date >= monday ? '#C6613F' : '#e00000';
}

export default function Dashboard() {
  const [projects, setProjects] = useState([]);
  const [studentName, setStudentName] = useState('');
  const [lastCheckin, setLastCheckin] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [formComplete, setFormComplete] = useState(false);

  useEffect(() => {
    fetch('/api/home-data')
      .then(res => res.json())
      .then(data => {
        if (data.error) setError(data.error);
        else {
          setProjects(data.activeProjects || []);
          setStudentName(data.studentName || '');
          setLastCheckin(data.lastCheckin || null);
        }
        setLoading(false);
      })
      .catch(() => {
        setError('Failed to load data');
        setLoading(false);
      });
  }, []);

  const checkinDateStr = formatCheckinDate(lastCheckin);
  const checkinColor = getCheckinColor(lastCheckin);

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

           <h2 style={{
          fontSize: '30px',
          fontWeight: '700',
          marginBottom: '0.4rem',
          color: '#111',
          fontFamily: "'DM Sans', 'Poppins', sans-serif",
        }}>
          {'Weekly Check-in Form'}
        </h2>

        <h3 style={{
          fontSize: '14px',
          fontStyle: Italic,
          fontWeight: '700',
          color: '#3c3c3c',
          fontFamily: "'DM Sans', 'Poppins', sans-serif",
        }}>
          {'Please fill this out to have a meeting with Director Ryan'}
        </h3>


        <p style={{
          fontSize: '13px',
          fontWeight: '500',
          marginBottom: '2rem',
          fontFamily: "'DM Sans', 'Poppins', sans-serif",
          color: checkinColor,
        }}>
         {checkinDateStr ? `Last check-in: ${checkinDateStr}` : ''}
        </p>



        {/* Container 3: Weekly Check-In + Booking */}
        <section style={{ marginBottom: '2rem' }}>
          <UpdateForm onFormComplete={() => setFormComplete(true)} />
        </section>

        {/* Container 2: Upcoming Meetings */}
        <section style={{ marginBottom: '2rem' }}>
          <UpcomingMeetings studentName={studentName} />
        </section>

      </main>
    </div>
  );
}