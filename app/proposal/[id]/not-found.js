// What a FAMILY sees when a proposal link does not resolve: a typo in the url,
// a link that was never saved, or a row that has since been removed. Next's
// default 404 is a black-on-white "This page could not be found" with no way to
// reach anyone, which for a prospect holding a dead link is the last page they
// see. This one renders inside app/proposal/layout.js, so the `.proposal-root`
// token scope, ground and type are already around it, and its only job is to
// hand over a phone number and an email address.

export const metadata = {
  title: 'Proposal not found · Admissions Partners',
  robots: { index: false, follow: false, nocache: true },
};

const FIRM = {
  phone: '(949) 910-5366',
  tel: '+19499105366',
  email: 'support@admissions.partners',
};

export default function ProposalNotFound() {
  return (
    <main className="pp-standalone">
      <p className="pp-mark">
        Admissions <i>|</i> Partners
      </p>
      <h1 className="pp-title">We could not find that proposal</h1>
      <p className="pp-meta" style={{ maxWidth: '46ch', marginTop: '0.9rem' }}>
        This link may have expired. Call us and we will resend it.
      </p>
      <p style={{ marginTop: '1.5rem', fontSize: '16px', fontWeight: 500 }}>
        <a className="pp-link" href={`tel:${FIRM.tel}`}>
          {FIRM.phone}
        </a>
        <span style={{ opacity: 0.5 }}> · </span>
        <a className="pp-link" href={`mailto:${FIRM.email}`}>
          {FIRM.email}
        </a>
      </p>
      <p className="pp-meta" style={{ marginTop: '2rem', fontSize: '13.5px' }}>
        930 Roosevelt, Suite 221-225, Irvine, CA 92620
      </p>
    </main>
  );
}
