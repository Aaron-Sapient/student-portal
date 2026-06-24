// Public (no auth — see proxy.js). POST { studentId, slug, responses }
// where responses = [{ target, type, selectedKey, selectedConnotation }].
// Scores server-side from canonical content, saves one attempt per student/quiz.
import { getSupabaseClient, SAT_QUIZZES, SAT_ATTEMPTS } from '@/lib/supabase'
import { scoreVocabResponses } from '@/lib/satQuiz'

export async function POST(request) {
  try {
    let body
    try {
      body = await request.json()
    } catch {
      return Response.json({ error: 'Bad request' }, { status: 400 })
    }
    const { studentId, slug, responses } = body || {}
    if (!studentId || !slug || !Array.isArray(responses)) {
      return Response.json({ error: 'Missing studentId, slug, or responses' }, { status: 400 })
    }

    const sb = getSupabaseClient()
    const { data: quiz } = await sb
      .from(SAT_QUIZZES)
      .select('id,slug,kind,content')
      .eq('slug', slug)
      .eq('active', true)
      .maybeSingle()
    if (!quiz) return Response.json({ error: 'Quiz not found' }, { status: 404 })

    // One attempt per student — if one already exists, return it (no re-grade).
    const { data: existing } = await sb
      .from(SAT_ATTEMPTS)
      .select('vocab_score,connotation_score,total,answers,created_at')
      .eq('student_id', studentId)
      .eq('quiz_id', quiz.id)
      .maybeSingle()
    if (existing) return Response.json({ alreadyTaken: true, result: existing })

    if (quiz.kind !== 'vocab') {
      return Response.json({ error: `Unsupported quiz kind: ${quiz.kind}` }, { status: 400 })
    }

    const scored = scoreVocabResponses(quiz.content, responses)

    const { data: inserted, error } = await sb
      .from(SAT_ATTEMPTS)
      .insert({
        student_id: studentId,
        quiz_id: quiz.id,
        vocab_score: scored.vocab_score,
        connotation_score: scored.connotation_score,
        total: scored.total,
        answers: scored.answers,
      })
      .select('vocab_score,connotation_score,total,answers,created_at')
      .single()

    // unique(student_id, quiz_id) backstops a double-submit race: if a concurrent
    // insert won, return the stored attempt instead of erroring.
    if (error) {
      if (error.code === '23505') {
        const { data: raced } = await sb
          .from(SAT_ATTEMPTS)
          .select('vocab_score,connotation_score,total,answers,created_at')
          .eq('student_id', studentId)
          .eq('quiz_id', quiz.id)
          .maybeSingle()
        if (raced) return Response.json({ alreadyTaken: true, result: raced })
      }
      throw error
    }

    return Response.json({ alreadyTaken: false, result: inserted })
  } catch (err) {
    console.error('sat/submit error:', err)
    return Response.json({ error: err.message || 'Server error' }, { status: 500 })
  }
}
