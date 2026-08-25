import './proposal.css';

// Public proposal surface (no auth — possession of the quote uuid is the
// capability, same moat as /write; see proxy.js isPublicRoute).
//
// This layout deliberately does NOT use PortalShell. PortalShell exists to put
// a surface inside `.portal-root`: claymorphic terracotta on cream, Fraunces +
// Hanken, a warm radial backdrop. That is the v1-era portal look, and the
// proposal page is the first surface off it. Everything this page needs — the
// token scope, the type, the ground — is declared on `.proposal-root` in
// ./proposal.css, which touches no `.portal-root` token, so neither surface can
// re-theme the other. The sans is Geist, already loaded on <body> by the root
// layout, so the switch costs no additional font request.
//
// The page column lives in the page itself rather than here: the comparison
// wants the full width and the letter wants a reading measure, and that split
// is the layout's whole idea.

export const metadata = {
  title: 'Proposal · Admissions Partners',
  // A capability URL is only private while it stays out of an index.
  robots: { index: false, follow: false, nocache: true },
};

export default function ProposalLayout({ children }) {
  return <div className="proposal-root">{children}</div>;
}
