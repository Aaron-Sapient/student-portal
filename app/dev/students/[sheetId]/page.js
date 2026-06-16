import StudentScorePage from '@/app/developer/(panel)/scoring/[sheetId]/page';

// Same per-student scoring page as /developer/scoring/[sheetId]; the component
// derives its back-link from the current pathname, so it returns to /dev/students.
export default function DevStudentPage() {
  return <StudentScorePage />;
}
