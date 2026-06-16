import { auth } from '@clerk/nextjs/server';
import { google } from 'googleapis';

// Student-driven progress write-back, scoped to RYAN-OWNED projects only.
// Students own the progress signal for Ryan's projects (Ryan won't keep % current);
// Aaron's projects are display-only and rejected here server-side regardless of UI.
// Writes the new % to 🏆 Comps & Projects col I; the col-J bar and the 📆 Meetings
// mirror recompute from I automatically. Owner attribution lives in col N.

const MASTER_SHEET_ID = '1YJK05oU_12wX0qK-vTqJJfaS8eVI7JMzdGP0gVso1G4';
const MASTER_TAB = '👩‍🎓 All Data';
const PROJECTS_TAB = '🏆 Comps & Projects';

function getServiceAuth() {
  return new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

export async function POST(request) {
  const { sessionClaims } = await auth();
  const email = sessionClaims?.email;
  if (!email) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid body' }, { status: 400 });
  }

  const projectKey = typeof body?.projectKey === 'string' ? body.projectKey.trim() : '';
  const progress = Number(body?.progress);
  if (!projectKey) return Response.json({ error: 'Missing projectKey' }, { status: 400 });
  if (!Number.isFinite(progress) || progress < 0 || progress > 100) {
    return Response.json({ error: 'Invalid progress' }, { status: 400 });
  }

  try {
    const sheets = google.sheets({ version: 'v4', auth: getServiceAuth() });

    // Resolve the student's individual sheet from the master (col J = email, col G = URL).
    const masterRes = await sheets.spreadsheets.values.get({
      spreadsheetId: MASTER_SHEET_ID,
      range: `${MASTER_TAB}!A:BB`,
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    const masterRows = masterRes.data.values || [];
    const studentRow = masterRows.find(r => r[9] === email); // col J
    if (!studentRow) return Response.json({ error: 'Student not found' }, { status: 404 });

    const sheetIdMatch = studentRow[6]?.match(/\/d\/([a-zA-Z0-9-_]+)/); // col G = URL
    if (!sheetIdMatch) return Response.json({ error: 'No student sheet found' }, { status: 404 });
    const studentSheetId = sheetIdMatch[1];

    // Re-read the LIVE project table and locate the row by key (col E concatenate),
    // never a client-supplied index — reorder-safe.
    const projRes = await sheets.spreadsheets.values.get({
      spreadsheetId: studentSheetId,
      range: `'${PROJECTS_TAB}'!E:N`, // E=key(0) … I=%(4) … N=Owner(9)
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    const projRows = projRes.data.values || [];
    const matchIndex = projRows.findIndex(
      r => typeof r[0] === 'string' && r[0].trim() === projectKey
    );
    if (matchIndex < 0) return Response.json({ error: 'Project not found' }, { status: 404 });

    // Owner guard — fail-safe: only an explicit 'Ryan' is writable here.
    const owner = (projRows[matchIndex][9] || '').toString().trim();
    if (owner !== 'Ryan') {
      return Response.json({ error: 'Project is not editable here' }, { status: 403 });
    }

    // E:N starts at row 1, so array index i → sheet row i + 1. Write % into col I
    // in the 0–1 domain to match the percent-formatted cell.
    const sheetRow = matchIndex + 1;
    await sheets.spreadsheets.values.update({
      spreadsheetId: studentSheetId,
      range: `'${PROJECTS_TAB}'!I${sheetRow}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[progress / 100]] },
    });

    return Response.json({ success: true, projectKey, progress });
  } catch (err) {
    console.error('updateProjectProgress error:', err);
    return Response.json({ error: 'Server error' }, { status: 500 });
  }
}
