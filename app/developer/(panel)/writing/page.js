import { redirect } from 'next/navigation';

// The Writing tab was retired from /developer — student essays + edited files are
// now reached from the unified Students tab (the folder icon on each card). Keep
// this route as a redirect so old bookmarks land on the replacement instead of
// 404ing. (WritingFilesTab still powers /dev/writing for Ryan.)
export default function DevWritingPage() {
  redirect('/developer/students');
}
