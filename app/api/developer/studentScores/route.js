import { DateTime } from 'luxon';
import { requireAdmin } from '@/lib/developerAuth';
import { getGoogleSheetsClient } from '@/lib/google';
import { readScoreParams } from '@/lib/scoreParams';
import { getStudentScores, gradeFromClass } from '@/lib/scores';
import {
  SCORES_TAB,
  clearCachedScores,
  getCachedScores,
  getWriteSheets,
  listRoster,
  setCachedScores,
} from './shared';

// GET: every student's latest holistic scores for the dev Scoring tab's
// spot-check pane. One Master Sheet read for the roster, then one 📊 Scores
// read per student (chunked — most sheets have no tab yet and return null
// fast). Students without a Scores tab are omitted entirely (info-once: no
// empty rows).
// POST: manual raw A/E/L adjustment — appends a `manual` row to the student's
// 📊 Scores tab. Overall recomputes from the ⚙️ Score Params blend; insight and
// coach note stay blank (no model reasoning to attach), so the next weekly run
// anchors its ±3 cap to the corrected values.

const CHUNK = 8;

export async function GET() {
  const gate = await requireAdmin();
  if (!gate.ok) return gate.response;

  const cached = getCachedScores();
  if (cached) return Response.json(cached);

  try {
    const sheets = getGoogleSheetsClient('developer-dashboard');
    const roster = await listRoster(sheets);

    const scored = [];
    for (let i = 0; i < roster.length; i += CHUNK) {
      const part = await Promise.all(
        roster.slice(i, i + CHUNK).map(async (s) => {
          const scores = await getStudentScores(sheets, s.sheetId, gradeFromClass(s.grade)).catch(() => null);
          if (!scores) return null;
          const { latest, prev, stale } = scores;
          return { ...s, latest, prev, stale };
        })
      );
      scored.push(...part.filter(Boolean));
    }

    scored.sort((a, b) => (b.latest.overall ?? -1) - (a.latest.overall ?? -1));
    const payload = { students: scored, rosterCount: roster.length };
    setCachedScores(payload);
    return Response.json(payload);
  } catch (err) {
    console.error('studentScores GET error:', err);
    // Quota errors are transient — an expired snapshot beats an error pane.
    const stale = getCachedScores({ allowExpired: true });
    if (stale) return Response.json(stale);
    return Response.json({ error: err.message || 'Server error' }, { status: 500 });
  }
}

export async function POST(request) {
  const gate = await requireAdmin();
  if (!gate.ok) return gate.response;

  try {
    const { sheetId, academic, ec, leadership } = await request.json();
    const subs = { academic, ec, leadership };
    for (const [key, v] of Object.entries(subs)) {
      if (!Number.isInteger(v) || v < 0 || v > 100) {
        return Response.json({ error: `Bad ${key}: must be an integer 0–100` }, { status: 400 });
      }
    }

    const sheets = getWriteSheets();
    // The sheet id carries no authority — it must belong to a roster student.
    const roster = await listRoster(sheets);
    if (!roster.some((s) => s.sheetId === sheetId)) {
      return Response.json({ error: 'Unknown student sheet' }, { status: 400 });
    }

    // Overall from the same blend the scorer uses (⚙️ Score Params tab,
    // falling back to defaults inside readScoreParams).
    const params = await readScoreParams(sheets);
    const w = {
      academic: params['overall.academic'] ?? 50,
      ec: params['overall.ec'] ?? 30,
      leadership: params['overall.leadership'] ?? 20,
    };
    const overall = Math.round(
      (w.academic * academic + w.ec * ec + w.leadership * leadership) / 100
    );

    const today = DateTime.now().setZone('America/Los_Angeles').toISODate();
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: `'${SCORES_TAB}'!A:I`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [[today, academic, ec, leadership, overall, '', '', 'v2', 'manual']],
      },
    });
    clearCachedScores();
    return Response.json({ success: true, overall });
  } catch (err) {
    console.error('studentScores POST error:', err);
    return Response.json({ error: err.message || 'Server error' }, { status: 500 });
  }
}
