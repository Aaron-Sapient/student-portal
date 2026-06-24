// Public (no auth — see proxy.js isPublicRoute). Powers the /sat home page:
// the student roster + the list of active quizzes (each rendered as a clay ball).
import { getSupabaseClient, SAT_STUDENTS, SAT_QUIZZES } from '@/lib/supabase'

export async function GET() {
  try {
    const sb = getSupabaseClient()
    const [{ data: students }, { data: quizzes }] = await Promise.all([
      sb.from(SAT_STUDENTS).select('id,name').eq('active', true).order('name'),
      sb.from(SAT_QUIZZES).select('slug,title,kind').eq('active', true).order('sort_order'),
    ])
    return Response.json({ students: students || [], quizzes: quizzes || [] })
  } catch (err) {
    console.error('sat/init error:', err)
    return Response.json({ error: err.message || 'Server error' }, { status: 500 })
  }
}
