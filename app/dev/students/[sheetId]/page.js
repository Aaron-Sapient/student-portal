import StudentScorePage from '@/app/developer/(panel)/scoring/[sheetId]/page';

// Same per-student scoring page as /developer/scoring/[sheetId]; the component
// derives its back-link and row links from the current pathname.
export default function DevStudentPage() {
  return <StudentScorePage />;
}
