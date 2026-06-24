// Public (no auth — see proxy.js). GET ?slug=&studentId=
//   - If the student already has an attempt → return the stored result so the
//     client renders the locked review (one attempt per student per quiz).
//   - Otherwise → return a freshly shuffled, answer-key-free quiz.
import { getSupabaseClient, SAT_QUIZZES, SAT_ATTEMPTS } from '@/lib/supabase'
import { buildVocabQuiz } from '@/lib/satQuiz'

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url)
    const slug = searchParams.get('slug')
    const studentId = searchParams.get('studentId')
    if (!slug) return Response.json({ error: 'Missing slug' }, { status: 400 })

    const sb = getSupabaseClient()
    const { data: quiz } = await sb
      .from(SAT_QUIZZES)
      .select('id,slug,title,kind,content')
      .eq('slug', slug)
      .eq('active', true)
      .maybeSingle()
    if (!quiz) return Response.json({ error: 'Quiz not found' }, { status: 404 })

    if (studentId) {
      const { data: attempt } = await sb
        .from(SAT_ATTEMPTS)
        .select('vocab_score,connotation_score,total,answers,created_at')
        .eq('student_id', studentId)
        .eq('quiz_id', quiz.id)
        .maybeSingle()
      if (attempt) {
        return Response.json({
          slug: quiz.slug,
          title: quiz.title,
          alreadyTaken: true,
          result: attempt,
        })
      }
    }

    if (quiz.kind !== 'vocab') {
      return Response.json({ error: `Unsupported quiz kind: ${quiz.kind}` }, { status: 400 })
    }
    const { questions } = buildVocabQuiz(quiz.content)
    return Response.json({ slug: quiz.slug, title: quiz.title, kind: quiz.kind, questions })
  } catch (err) {
    console.error('sat/quiz error:', err)
    return Response.json({ error: err.message || 'Server error' }, { status: 500 })
  }
}
