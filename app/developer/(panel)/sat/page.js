import { Suspense } from 'react';
import SatScoresTab from './SatScoresTab';

export const metadata = { title: 'SAT Scores · Dev Portal' };

// useSearchParams (the ?student=<slug> detail route) requires a Suspense boundary.
export default function SatScoresPage() {
  return (
    <Suspense fallback={null}>
      <SatScoresTab />
    </Suspense>
  );
}
