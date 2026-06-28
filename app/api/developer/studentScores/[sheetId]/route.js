import { requireAdmin } from '@/lib/developerAuth';
import { getGoogleSheetsClient } from '@/lib/google';
import { readScoreParams } from '@/lib/scoreParams';
import { curveScore, gradeFromClass } from '@/lib/scores';
import {
  SCORES_TAB,
  clearCachedScores,
  getWriteSheets,
  listRoster,
} from '../shared';
import { getCheckinTimeline } from '@/lib/checkins';

// GET: one student's full scoring history (every 📊 Scores row, with its sheet
// row number so sessions can be edited in place) plus their check-in dates
// from the master sheet's two form-log tabs — the dev student page charts
// both timelines together.
// PATCH: edit a specific scoring session in place — raw A/E/L scores, plus
// (optionally) the Insight and CoachNote text (cols F:G; the latest row's
// CoachNote is what /api/coach serves to the student). Overall recomputes
// from the ⚙️ Score Params blend and the Model column gets an "· edited"
// stamp so the provenance stays visible.

// Same column layout lib/scores.js parses, but keeping the sheet row number
// and both raw + shown values (the page shows the pair while calibration is
// in flux).
function parseSession(r, idx, grade) {
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
  };
  const date = String(r[0] || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(date)) return null;
  const isV1 = r[6] === 'v1';
  const raw = {
    academic: num(r[1]),
    ec: num(r[2]),
    leadership: isV1 ? null : num(r[3]),
    overall: isV1 ? num(r[3]) : num(r[4]),
  };
  return {
    row: idx + 2, // values read from A2 down
    date: date.slice(0, 10),
    raw,
    shown: {
      academic: curveScore(raw.academic, grade),
      ec: curveScore(raw.ec, grade),
      leadership: curveScore(raw.leadership, grade),
      overall: curveScore(raw.overall, grade),
    },
    insight: ((isV1 ? r[4] : r[5]) || '').trim() || null,
    coachNote: ((isV1 ? r[5] : r[6]) || '').trim() || null,
    rubricVer: isV1 ? 'v1' : (r[7] || '').trim() || null,
    model: ((isV1 ? r[7] : r[8]) || '').trim() || null,
    v1: isV1,
  };
}

export async function GET(_request, { params }) {
  const gate = await requireAdmin();
  if (!gate.ok) return gate.response;

  try {
    const { sheetId } = await params;
    const sheets = getGoogleSheetsClient('developer-dashboard');
    const roster = await listRoster(sheets);
    const student = roster.find((s) => s.sheetId === sheetId);
    if (!student) {
      return Response.json({ error: 'Unknown student sheet' }, { status: 404 });
    }

    const [scoresRes, checkins] = await Promise.all([
      sheets.spreadsheets.values
        .get({ spreadsheetId: sheetId, range: `'${SCORES_TAB}'!A2:I400` })
        .catch(() => null), // tab not created yet
      // Check-in tick list per the `checkins` flag (Sheets today): both form-log
      // tabs joined by normalized name → [{date,who}] sorted. Dispatch is internal.
      getCheckinTimeline(sheets, sheetId, student.name),
    ]);

    const grade = gradeFromClass(student.grade);
    const sessions = (scoresRes?.data.values || [])
      .map((r, i) => parseSession(r, i, grade))
      .filter(Boolean)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.row - b.row));

    return Response.json({ ...student, sessions, checkins });
  } catch (err) {
    console.error('studentScores [sheetId] GET error:', err);
    return Response.json({ error: err.message || 'Server error' }, { status: 500 });
  }
}

export async function PATCH(request, { params }) {
  const gate = await requireAdmin();
  if (!gate.ok) return gate.response;

  try {
    const { sheetId } = await params;
    const { row, date, academic, ec, leadership, insight, coachNote } = await request.json();
    for (const [k, v] of Object.entries({ academic, ec, leadership })) {
      if (!Number.isInteger(v) || v < 0 || v > 100) {
        return Response.json({ error: `Bad ${k}: must be an integer 0–100` }, { status: 400 });
      }
    }
    // Text fields are optional (absent = leave the cell alone); empty string
    // is a deliberate clear — e.g. blanking a coach note suppresses it in the
    // student portal.
    for (const [k, v] of Object.entries({ insight, coachNote })) {
      if (v !== undefined && typeof v !== 'string') {
        return Response.json({ error: `Bad ${k}: must be a string` }, { status: 400 });
      }
    }
    if (!Number.isInteger(row) || row < 2) {
      return Response.json({ error: 'Bad row' }, { status: 400 });
    }

    const sheets = getWriteSheets();
    // The sheet id carries no authority — it must belong to a roster student.
    const roster = await listRoster(sheets);
    if (!roster.some((s) => s.sheetId === sheetId)) {
      return Response.json({ error: 'Unknown student sheet' }, { status: 400 });
    }

    // Re-read the target row and require its date to match what the client
    // saw — guards against editing the wrong session if rows shifted.
    const rowRes = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `'${SCORES_TAB}'!A${row}:I${row}`,
    });
    const cells = rowRes.data.values?.[0];
    if (!cells || String(cells[0] || '').slice(0, 10) !== date) {
      return Response.json(
        { error: 'Session row moved — reload and try again' },
        { status: 409 }
      );
    }
    if (cells[6] === 'v1') {
      return Response.json({ error: 'v1 rows have a different layout — not editable' }, { status: 400 });
    }

    const sheetParams = await readScoreParams(sheets);
    const w = {
      academic: sheetParams['overall.academic'] ?? 50,
      ec: sheetParams['overall.ec'] ?? 30,
      leadership: sheetParams['overall.leadership'] ?? 20,
    };
    const overall = Math.round(
      (w.academic * academic + w.ec * ec + w.leadership * leadership) / 100
    );

    const model = String(cells[8] || '').trim();
    const stamped = model.includes('edited') ? model : model ? `${model} · edited` : 'edited';
    const data = [
      {
        range: `'${SCORES_TAB}'!B${row}:E${row}`,
        values: [[academic, ec, leadership, overall]],
      },
      { range: `'${SCORES_TAB}'!I${row}`, values: [[stamped]] },
    ];
    if (typeof insight === 'string' || typeof coachNote === 'string') {
      // One F:G write; whichever field wasn't sent keeps its current value.
      data.push({
        range: `'${SCORES_TAB}'!F${row}:G${row}`,
        values: [
          [
            typeof insight === 'string' ? insight.trim() : String(cells[5] ?? ''),
            typeof coachNote === 'string' ? coachNote.trim() : String(cells[6] ?? ''),
          ],
        ],
      });
    }
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: { valueInputOption: 'RAW', data },
    });
    clearCachedScores();
    return Response.json({ success: true, overall });
  } catch (err) {
    console.error('studentScores [sheetId] PATCH error:', err);
    return Response.json({ error: err.message || 'Server error' }, { status: 500 });
  }
}
