import SatQuiz from './SatQuiz';

// Server shell: unwraps the route param (Next 16 params is async) and hands the
// slug to the interactive client component. Public — no auth (see proxy.js).
export default async function SatQuizPage({ params }) {
  const { slug } = await params;
  return <SatQuiz slug={slug} />;
}
