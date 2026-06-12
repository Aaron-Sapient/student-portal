'use client';

import { PageHeader } from '@/app/developer/(panel)/devUi';
import StudentScores from '@/app/developer/(panel)/scoring/StudentScores';

export default function DevStudentsPage() {
  return (
    <div>
      <PageHeader eyebrow="Holistic scores" title="Students" />
      <StudentScores className="" delay={90} />
    </div>
  );
}
