import StudentHub from '@/app/developer/(panel)/students/StudentHub';

// The per-student hub on the Ryan-facing /dev surface. StudentHub derives its
// back-link (/dev/students) and full-scoring link (/dev/scoring/<id>) from the
// pathname, so the one component serves both surfaces.
export default function DevStudentPage() {
  return <StudentHub />;
}
