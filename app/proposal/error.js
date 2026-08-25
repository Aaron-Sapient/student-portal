'use client';

// The error boundary for the public proposal surface. Without it a throw here
// falls through to app/error.js, which is the SIGNED-IN portal's boundary: it
// calls useClerk and offers a "Sign out" button to a family that has no account
// and never signed in. Renders inside app/proposal/layout.js, so the
// `.proposal-root` token scope is already around it, and the exit is a phone
// number rather than an auth action.

const FIRM = {
  phone: '(949) 910-5366',
  tel: '+19499105366',
  email: 'support@admissions.partners',
};

export default function ProposalError({ error, reset }) {
  return (
    <main className="pp-standalone">
      <p className="pp-mark">
        Admissions <i>|</i> Partners
      </p>
      <h1 className="pp-title">We could not open that proposal</h1>
      <p className="pp-meta" style={{ maxWidth: '46ch', marginTop: '0.9rem' }}>
        This one is on us, not on you. Try again, and if it keeps happening we will send you a
        fresh link.
      </p>
      <div style={{ marginTop: '1.5rem' }}>
        <button type="button" className="pp-btn" onClick={() => reset()}>
          Try again
        </button>
      </div>
      <p style={{ marginTop: '1.5rem', fontSize: '16px', fontWeight: 500 }}>
        <a className="pp-link" href={`tel:${FIRM.tel}`}>
          {FIRM.phone}
        </a>
        <span style={{ opacity: 0.5 }}> · </span>
        <a className="pp-link" href={`mailto:${FIRM.email}`}>
          {FIRM.email}
        </a>
      </p>
      {error?.digest && (
        <p className="pp-meta" style={{ marginTop: '2rem', fontSize: '13px' }}>
          Reference: {error.digest}
        </p>
      )}
    </main>
  );
}
