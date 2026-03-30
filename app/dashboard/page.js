'use client'
import { useEffect, useState } from 'react';
import UpdateForm from '@/components/UpdateForm';
import UpcomingMeetings from '@/components/UpcomingMeetings';

export default function Dashboard() {
  const [projects, setProjects] = useState([]);
  const [studentName, setStudentName] = useState('');
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
        }
        setLoading(false);
      })
      .catch(() => {
        setError('Failed to load data');
        setLoading(false);
      });
  }, []);

  return (
    <div style={{ backgroundColor: '#FAF9F4', minHeight: '100vh', width: '100%' }}>
      <main style={{ padding: '2rem', maxWidth: '720px', margin: '0 auto' }}>

        <h1 style={{
          fontSize: '24px',
          fontWeight: '700',
          marginBottom: '2rem',
          color: '#111',
          fontFamily: "'DM Sans', 'Poppins', sans-serif",
        }}>
          {studentName ? `Welcome, ${studentName.split(' ')[0]}` : 'My Dashboard'}
        </h1>

        {/* Container 1: Current Projects — hidden for now */}
        {/* Uncomment to restore:
        <section style={{ marginBottom: '2rem' }}>
          ...projects content...
        </section>
        */}

        {/* Container 2: Upcoming Meetings */}
        <section style={{ marginBottom: '2rem' }}>
          <UpcomingMeetings studentName={studentName} />
        </section>

        {/* Container 3: Weekly Check-In + Booking */}
        <section style={{ marginBottom: '2rem' }}>
          <UpdateForm onFormComplete={() => setFormComplete(true)} />
        </section>

        {/* DEV ONLY — remove before launch */}
        <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
          <button
            onClick={async () => {
              await fetch('/api/devSetBookingToken', { method: 'POST' });
              window.location.href = '/booking?type=30';
            }}
            style={{ fontSize: '0.75rem', color: '#aaa', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}
          >
            [dev] test 30min booking
          </button>
        </div>

      </main>
    </div>
  );
}