import PortalShell from '@/components/portal/PortalShell';

export const metadata = {
  title: 'Edit document · Admissions.Partners',
};

// Full-screen, chromeless editor surface. It reuses PortalShell purely for the
// design tokens (fonts, the .portal-root scope that the neu-* classes need, the
// warm backdrop) — but deliberately NOT the (portal) layout, so there's no tab
// dock and no narrow content column. The page fills the viewport.
export default function EditLayout({ children }) {
  return <PortalShell iconNames="edit_document">{children}</PortalShell>;
}
