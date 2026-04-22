'use client';
import { useState } from 'react';
import './parents.css';

export default function ParentsPage() {
  const [parentEmail, setParentEmail] = useState('');
  const [concern, setConcern] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    if (!parentEmail.trim() || !concern.trim()) return;
    setSubmitting(true);
    setError('');

    try {
      const res = await fetch('/api/parentCheckin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          parentEmail: parentEmail.trim(),
          concern: concern.trim(),
        }),
      });
      const result = await res.json();
      if (!result.success) throw new Error(result.error || 'Submission failed');
      setSubmitted(true);
    } catch (err) {
      setError(err.message || 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <div style={styles.page}>
        <div style={styles.logoArea}>
          <div style={styles.logoName}>Admissions | Partners</div>
          <div style={styles.logoSub}>a <strong>Ryan Choice</strong> company</div>
        </div>
        <div style={styles.headline}>
          <h1 style={styles.headlineText}>
            Your <em style={styles.headlineAccent}>partnership</em>
          </h1>
          <h1 style={styles.headlineText}>awaits.</h1>
        </div>
        <div style={styles.card}>
          <div style={styles.successIcon}>✓</div>
          <h2 style={styles.successTitle}>Thanks for submitting!</h2>
          <p style={styles.successText}>We will get back to you shortly.</p>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.page}>
      <div style={styles.logoArea}>
        <div style={styles.logoName}>Admissions | Partners</div>
        <div style={styles.logoSub}>a <strong>Ryan Choice</strong> company</div>
      </div>

      <div style={styles.headline}>
        <h1 style={styles.headlineText}>
          Your <em style={styles.headlineAccent}>partnership</em>
        </h1>
        <h1 style={styles.headlineText}>awaits.</h1>
        <p style={styles.headlineSub}>Request meetings here.</p>
      </div>

      <form onSubmit={handleSubmit} style={styles.card}>

        {/* Parent Email */}
        <div style={styles.fieldGroup}>
          <label style={styles.label}>
            Parent Email <span style={styles.required}>*</span>
          </label>
          <input
            type="email"
            value={parentEmail}
            onChange={e => { setParentEmail(e.target.value); setError(''); }}
            placeholder="Email"
            style={styles.input}
            className="parent-input"
            required
            disabled={submitting}
          />
        </div>

        {/* Question / Concern */}
        <div style={{ ...styles.fieldGroup, marginTop: '1.75rem' }}>
          <label style={styles.labelLarge}>Question/Concern</label>
          <p style={styles.fieldDesc}>
            Please let us know the <strong>purpose</strong> of your requested meeting,
            including any associated <strong>deadlines</strong>.
          </p>
          <textarea
            value={concern}
            onChange={e => { setConcern(e.target.value); setError(''); }}
            placeholder="Describe your question or concern"
            style={styles.textarea}
            className="parent-input"
            rows={6}
            required
            disabled={submitting}
          />
        </div>

        {error && <p style={styles.errorText}>{error}</p>}

        <div style={styles.submitRow}>
          <button
            type="submit"
            disabled={submitting || !parentEmail.trim() || !concern.trim()}
            style={styles.submitBtn}
            className="parent-submit-btn"
          >
            {submitting ? 'Submitting…' : 'Submit ↑'}
          </button>
        </div>

      </form>
    </div>
  );
}

const styles = {
  page: {
    backgroundColor: '#FAF9F4',
    minHeight: '100vh',
    width: '100%',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    padding: '2.5rem 1.5rem 4rem',
    fontFamily: "'DM Sans', 'Poppins', sans-serif",
  },
  logoArea: {
    alignSelf: 'flex-start',
    marginBottom: '3rem',
    paddingLeft: '0.5rem',
  },
  logoName: {
    fontSize: '1rem',
    fontWeight: '500',
    color: '#111',
    letterSpacing: '0.01em',
    fontFamily: "'DM Sans', 'Poppins', sans-serif",
  },
  logoSub: {
    fontSize: '0.8rem',
    color: '#888',
    fontFamily: "'DM Sans', 'Poppins', sans-serif",
  },
  headline: {
    textAlign: 'center',
    marginBottom: '2.5rem',
  },
  headlineText: {
    margin: 0,
    fontSize: 'clamp(2rem, 6vw, 3rem)',
    fontWeight: '500',
    color: '#111',
    lineHeight: 1.15,
    fontFamily: "'DM Sans', 'Poppins', sans-serif",
    letterSpacing: '-0.02em',
  },
  headlineAccent: {
    color: '#C6613F',
    fontStyle: 'italic',
    fontFamily: 'Georgia, serif',
    fontWeight: '400',
  },
  headlineSub: {
    marginTop: '0.75rem',
    fontSize: '1rem',
    color: '#666',
    fontFamily: "'DM Sans', 'Poppins', sans-serif",
  },
  card: {
    width: '100%',
    maxWidth: '560px',
    backgroundColor: 'transparent',
  },
  fieldGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
  },
  label: {
    fontSize: '1rem',
    fontWeight: '700',
    color: '#111',
    fontFamily: "'DM Sans', 'Poppins', sans-serif",
  },
  labelLarge: {
    fontSize: '1.5rem',
    fontWeight: '600',
    color: '#111',
    fontFamily: "'DM Sans', 'Poppins', sans-serif",
    letterSpacing: '-0.01em',
  },
  required: {
    color: '#C6613F',
    marginLeft: '2px',
  },
  fieldDesc: {
    fontSize: '0.9rem',
    color: '#444',
    margin: 0,
    fontFamily: "'DM Sans', 'Poppins', sans-serif",
    lineHeight: 1.5,
  },
  input: {
    width: '55%',
    padding: '0.8rem 1rem',
    border: '1px solid #D5D3CC',
    borderRadius: '12px',
    backgroundColor: '#F0EEE8',
    fontSize: '0.95rem',
    fontFamily: "'DM Sans', 'Poppins', sans-serif",
    color: '#111',
    outline: 'none',
    boxSizing: 'border-box',
    transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
  },
  textarea: {
    width: '100%',
    padding: '1rem',
    border: '1px solid #D5D3CC',
    borderRadius: '12px',
    backgroundColor: '#F0EEE8',
    fontSize: '0.95rem',
    fontFamily: "'DM Sans', 'Poppins', sans-serif",
    color: '#111',
    outline: 'none',
    boxSizing: 'border-box',
    resize: 'none',
    lineHeight: 1.6,
    transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
  },
  errorText: {
    color: '#c0392b',
    fontSize: '0.82rem',
    marginTop: '0.5rem',
    fontFamily: "'DM Sans', 'Poppins', sans-serif",
  },
  submitRow: {
    display: 'flex',
    justifyContent: 'center',
    marginTop: '2rem',
  },
  submitBtn: {
    backgroundColor: '#C6613F',
    color: 'white',
    border: 'none',
    borderRadius: '12px',
    padding: '0.75rem 2.5rem',
    fontSize: '1rem',
    fontWeight: '600',
    cursor: 'pointer',
    fontFamily: "'DM Sans', 'Poppins', sans-serif",
    transition: 'opacity 0.15s ease',
  },
  successIcon: {
    width: '56px',
    height: '56px',
    borderRadius: '50%',
    backgroundColor: 'rgba(198, 97, 63, 0.12)',
    color: '#C6613F',
    fontSize: '1.5rem',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    margin: '0 auto 1rem',
    fontWeight: '700',
  },
  successTitle: {
    margin: '0 0 0.5rem',
    fontSize: '1.5rem',
    fontWeight: '700',
    color: '#111',
    textAlign: 'center',
    fontFamily: "'DM Sans', 'Poppins', sans-serif",
  },
  successText: {
    margin: 0,
    fontSize: '1rem',
    color: '#666',
    textAlign: 'center',
    fontFamily: "'DM Sans', 'Poppins', sans-serif",
  },
};