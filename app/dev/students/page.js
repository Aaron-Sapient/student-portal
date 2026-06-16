import { PageHeader } from '@/app/developer/(panel)/devUi';
import { StudentScores } from '@/app/developer/(panel)/scoring/ScoringTab';

// The student-list tab. StudentScores derives its row links from the current
// pathname, so rows point at /dev/students/<id> here.
export const metadata = { title: 'Students · Dev Portal' };

export default function DevStudentsPage() {
  return (
    <div>
      <PageHeader eyebrow="Holistic scores" title="Students" />
      <StudentScores />
    </div>
  );
}
