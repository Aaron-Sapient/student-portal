import { requireAdmin } from '@/lib/developerAuth'
import { listQuotes, saveQuote } from '@/lib/pricing'

// Record-keeping for built proposals (replaces the sheet's "save student
// profile"). GET → newest-first list; POST → save one. Admin-gated.

export async function GET() {
  const gate = await requireAdmin()
  if (!gate.ok) return gate.response

  try {
    const quotes = await listQuotes()
    return Response.json({ quotes })
  } catch (err) {
    console.error('packageQuotes GET error:', err)
    return Response.json({ error: err.message || 'Server error' }, { status: 500 })
  }
}

export async function POST(request) {
  const gate = await requireAdmin()
  if (!gate.ok) return gate.response

  try {
    const body = await request.json()
    const { studentName, grade, selection, emailHtml } = body || {}
    if (!selection || typeof selection !== 'object') {
      return Response.json({ error: 'Missing selection' }, { status: 400 })
    }
    const quote = await saveQuote({ studentName, grade, selection, emailHtml, createdBy: gate.email })
    return Response.json({ success: true, quote })
  } catch (err) {
    console.error('packageQuotes POST error:', err)
    return Response.json({ error: err.message || 'Server error' }, { status: 500 })
  }
}
