import { requireDeveloper } from '@/lib/developerAuth';
import { getSupabaseClient, SAT_STUDENTS, SAT_QUIZZES, SAT_ATTEMPTS } from '@/lib/supabase';

// GET: every ACTIVE SAT student with their saved attempts (vocab + grammar), for
// the /developer SAT tab. One read each for the roster, the active quiz registry,
// and all attempts — grouped in JS so a student with no attempts still appears
// (and an inactive student, e.g. one who left the cohort, drops out entirely).
// Developer-only: the answer key + every student's review record live in here.
export async function GET() {
  const gate = await requireDeveloper();
  if (!gate.ok) return gate.response;

  try {
    const sb = getSupabaseClient();
    const [{ data: students }, { data: quizzes }, { data: attempts }] = await Promise.all([
      sb.from(SAT_STUDENTS).select('id,name').eq('active', true).order('name'),
      sb
        .from(SAT_QUIZZES)
        .select('id,slug,title,kind,sort_order')
        .eq('active', true)
        .order('sort_order'),
      sb
        .from(SAT_ATTEMPTS)
        .select('student_id,quiz_id,vocab_score,connotation_score,total,answers,created_at')
        .order('created_at'),
    ]);

    const quizById = new Map((quizzes || []).map((q) => [q.id, q]));
    const byStudent = new Map();
    for (const a of attempts || []) {
      const q = quizById.get(a.quiz_id);
      if (!q) continue; // skip attempts on inactive/removed quizzes
      const list = byStudent.get(a.student_id) || [];
      list.push({
        slug: q.slug,
        title: q.title,
        kind: q.kind,
        sortOrder: q.sort_order,
        vocabScore: a.vocab_score,
        connotationScore: a.connotation_score,
        total: a.total,
        createdAt: a.created_at,
        answers: a.answers || [],
      });
      byStudent.set(a.student_id, list);
    }

    const result = (students || []).map((s) => ({
      id: s.id,
      name: s.name,
      attempts: (byStudent.get(s.id) || []).sort((x, y) => x.sortOrder - y.sortOrder),
    }));

    return Response.json({
      students: result,
      quizzes: (quizzes || []).map((q) => ({
        slug: q.slug,
        title: q.title,
        kind: q.kind,
        sortOrder: q.sort_order,
      })),
    });
  } catch (err) {
    console.error('satScores GET error:', err);
    return Response.json({ error: err.message || 'Server error' }, { status: 500 });
  }
}
