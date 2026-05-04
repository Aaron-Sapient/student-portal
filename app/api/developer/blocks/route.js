import { google } from 'googleapis';
import { requireDeveloper } from '@/lib/developerAuth';
import { listBlocks, addBlock, deleteBlock } from '@/lib/blocks';

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
  const gate = await requireDeveloper();
  if (!gate.ok) return gate.response;

  try {
    const sheets = google.sheets({ version: 'v4', auth: getServiceAuth() });
    const blocks = await listBlocks(sheets);
    return Response.json({ blocks });
  } catch (err) {
    console.error('blocks GET error:', err);
    return Response.json({ error: err.message || 'Server error' }, { status: 500 });
  }
}

export async function POST(request) {
  const gate = await requireDeveloper();
  if (!gate.ok) return gate.response;

  try {
    const { instructor, startDate, endDate, reason } = await request.json();
    if (!instructor || !startDate) {
      return Response.json({ error: 'Missing instructor or startDate' }, { status: 400 });
    }
    const sheets = google.sheets({ version: 'v4', auth: getServiceAuth() });
    await addBlock(sheets, { instructor, startDate, endDate, reason });
    return Response.json({ success: true });
  } catch (err) {
    console.error('blocks POST error:', err);
    return Response.json({ error: err.message || 'Server error' }, { status: 500 });
  }
}

export async function DELETE(request) {
  const gate = await requireDeveloper();
  if (!gate.ok) return gate.response;

  try {
    const { rowIndex } = await request.json();
    if (!rowIndex || rowIndex < 2) {
      return Response.json({ error: 'Invalid rowIndex' }, { status: 400 });
    }
    const sheets = google.sheets({ version: 'v4', auth: getServiceAuth() });
    await deleteBlock(sheets, rowIndex);
    return Response.json({ success: true });
  } catch (err) {
    console.error('blocks DELETE error:', err);
    return Response.json({ error: err.message || 'Server error' }, { status: 500 });
  }
}
