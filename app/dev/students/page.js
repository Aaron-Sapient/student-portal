import StudentsTab from '@/app/developer/(panel)/students/StudentsTab';

// The unified Students tab on the Ryan-facing /dev surface. StudentsTab derives
// its card links + back-nav from the current pathname, so cards point at
// /dev/students/<id> here. (Was the holistic-scores list — that view still lives
// at /dev/scoring.)
export const metadata = { title: 'Students · Dev Portal' };

export default function DevStudentsPage() {
  return <StudentsTab />;
}
