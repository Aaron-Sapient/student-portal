import ScoringTab from '@/app/developer/(panel)/scoring/ScoringTab';

// Params editor only — the student list has its own Students tab here.
export default function DevScoringPage() {
  return <ScoringTab includeStudents={false} />;
}
