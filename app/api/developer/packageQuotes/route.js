import { requireAdmin } from '@/lib/developerAuth'
import { listQuotes, saveQuote, updateQuote, findQuotesByStudentName, readPricing } from '@/lib/pricing'

// package_quotes.id is a uuid; Postgres raises on a malformed one, so a bad
// `updateId` answers 400 rather than surfacing a raw Postgres string as a 500.
// Both sibling routes guard this the same way.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Record-keeping for built proposals (replaces the sheet's "save student
// profile"). GET → newest-first list; POST → save one. Admin-gated.
//
// POST is deliberately a three-step conversation rather than a blind insert,
// because a blind insert is what let four rows for one student pile up in a
// single afternoon:
//   1. no `updateId` / `forceNew` → the server looks for an existing proposal
//      with the same student name and answers 409 { duplicate } if it finds
//      one. Nothing is written.
//   2. `updateId` → overwrite that row in place (content only).
//   3. `forceNew: true` → insert anyway; genuinely a different student who
//      happens to share a name.
// The check lives here, not in the browser, so a row saved by another admin
// moments ago is still caught.

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
    const { studentName, grade, selection, emailHtml, leadId, updateId, forceNew, sourceId } = body || {}
    if (!selection || typeof selection !== 'object') {
      return Response.json({ error: 'Missing selection' }, { status: 400 })
    }
    // A nameless proposal cannot be deduplicated (the name IS the key), so
    // blank names would pile up "Untitled" rows exactly as before — the
    // original bug, unmitigated. Reject rather than wave through.
    if (!String(studentName || '').trim()) {
      return Response.json({ error: 'Add the student’s name before saving.' }, { status: 400 })
    }
    // Snapshot the active config into the row so the contract derivation can
    // reproduce the family's numbers after the pricing dashboard moves.
    const config = await readPricing()

    if (updateId) {
      if (!UUID_RE.test(String(updateId))) {
        return Response.json({ error: 'Invalid quote id' }, { status: 400 })
      }
      try {
        const quote = await updateQuote(updateId, { studentName, grade, selection, emailHtml, config, updatedBy: gate.email })
        return Response.json({ success: true, updated: true, quote })
      } catch (err) {
        // A provisioned proposal is the record of what a family accepted, so
        // it is refused rather than overwritten. 409 with the reason, and the
        // builder offers "save as new" instead of a dead end.
        if (err.code === 'PROVISIONED') {
          return Response.json({ error: err.message, provisioned: true }, { status: 409 })
        }
        throw err
      }
    }

    if (!forceNew) {
      // Only unprovisioned rows are update candidates: re-quoting a family who
      // already signed is genuinely a NEW proposal, and offering "update" for
      // a row the server will always refuse makes the primary button a trap.
      const matches = (await findQuotesByStudentName(studentName)).filter((r) => !r.provisioned_at)
      if (matches.length) {
        // Which row does "update" mean? If the builder was opened FROM one of
        // these, it means that one. Otherwise a single match is unambiguous —
        // but with several, guessing "the newest" can silently overwrite a
        // different family who happens to share a name (that is what forceNew
        // creates). Ambiguity is reported, never resolved by guessing.
        const fromSource = sourceId && matches.find((r) => r.id === sourceId)
        const target = fromSource || (matches.length === 1 ? matches[0] : null)
        return Response.json({ duplicate: target, matches: matches.length }, { status: 409 })
      }
    }

    const quote = await saveQuote({ studentName, grade, selection, emailHtml, leadId, config, createdBy: gate.email })
    return Response.json({ success: true, quote })
  } catch (err) {
    console.error('packageQuotes POST error:', err)
    return Response.json({ error: err.message || 'Server error' }, { status: 500 })
  }
}
