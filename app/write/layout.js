import PortalShell from '@/components/portal/PortalShell';

export const metadata = {
  title: 'Write · Admissions.Partners',
};

// Full-screen, chromeless word-processor surface (opened in a new browser tab
// from the Colleges cards). Reuses PortalShell only for the design tokens —
// fonts, the .portal-root scope the --mde-* skin + neu-* classes need, the warm
// backdrop — but NOT the (portal) layout, so there's no tab dock. The doc fills
// the viewport, Google-Docs style.
export default function WriteLayout({ children }) {
  return <PortalShell iconNames="arrow_back,check,history,stylus_note">{children}</PortalShell>;
}
