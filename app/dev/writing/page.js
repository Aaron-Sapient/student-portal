import WritingFilesTab from '@/app/developer/(panel)/writing/WritingFilesTab';

// The combined Writing tab on the Ryan-facing /dev surface (same component as
// /developer/writing). The shared APIs it calls are admin-gated, so Ryan can
// search any student and review their essays + edited files.
export const metadata = { title: 'Writing · Dev Portal' };

export default function DevWritingPage() {
  return <WritingFilesTab />;
}
