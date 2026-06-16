import { google } from 'googleapis';
import { requireAdmin } from '@/lib/developerAuth';
import {
  PARAM_GROUPS,
  DEFAULT_PARAMS,
  readScoreParams,
  validateScoreParams,
  writeScoreParams,
} from '@/lib/scoreParams';

// Write-scoped client (lib/google's shared client is sheets read-only).
function getServiceAuth() {
  return new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

export async function GET() {
  const gate = await requireAdmin();
  if (!gate.ok) return gate.response;

  try {
    const sheets = google.sheets({ version: 'v4', auth: getServiceAuth() });
    const params = await readScoreParams(sheets);
    return Response.json({ params, defaults: DEFAULT_PARAMS, groups: PARAM_GROUPS });
  } catch (err) {
    console.error('score-params GET error:', err);
    return Response.json({ error: err.message || 'Server error' }, { status: 500 });
  }
}

export async function POST(request) {
  const gate = await requireAdmin();
  if (!gate.ok) return gate.response;

  try {
    const { params } = await request.json();
    const invalid = validateScoreParams(params);
    if (invalid) return Response.json({ error: invalid }, { status: 400 });

    const sheets = google.sheets({ version: 'v4', auth: getServiceAuth() });
    await writeScoreParams(sheets, params);
    return Response.json({ success: true });
  } catch (err) {
    console.error('score-params POST error:', err);
    return Response.json({ error: err.message || 'Server error' }, { status: 500 });
  }
}
