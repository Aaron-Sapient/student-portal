import { auth } from '@clerk/nextjs/server';
import { google } from 'googleapis';
import { DateTime } from 'luxon';
import { getGoogleSheetsClient } from '@/lib/google';
import { resolveIdentity, sessionEmail, classYearFromClass } from '@/lib/identity';
import { getSupabaseClient, STUDENT_AP_SCORES, AP_SCORE_REPORTS } from '@/lib/supabase';
import {
  AP_SUBJECTS,
  gradeYearJustCompleted,
  getDetectedApCourses,
  writeApScoresToStudentInfo,
} from '@/lib/apScores';

const ZONE = 'America/Los_Angeles';

function getServiceAuth() {
  return new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

function sheetIdFromPortalUrl(url) {
  const m = String(url ?? '').match(/\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : null;
}

// Resolves the logged-in STUDENT (not a parent viewing on their behalf — this
// is the student's own self-report of their own exam results).
async function resolveStudent() {
  const { sessionClaims } = await auth();
  const email = sessionEmail(sessionClaims);
  if (!email) return { error: Response.json({ error: 'Unauthorized' }, { status: 401 }) };

  const sheets = getGoogleSheetsClient(email);
  const identity = await resolveIdentity(sheets, email);
  if (identity.role !== 'student') {
    return { error: Response.json({ error: 'Forbidden' }, { status: 403 }) };
  }
  const sheetId = sheetIdFromPortalUrl(identity.studentRow?.[6]);
  if (!sheetId) {
    return { error: Response.json({ error: 'No student sheet on record' }, { status: 404 }) };
  }
  const gradYear = classYearFromClass(identity.studentRow?.[1]);
  return { email, sheets, sheetId, gradYear };
}

export async function GET() {
  const resolved = await resolveStudent();
  if (resolved.error) return resolved.error;
  const { sheets, sheetId, gradYear } = resolved;

  const nowLA = DateTime.now().setZone(ZONE);
  const reportYear = nowLA.year;
  const sb = getSupabaseClient();

  const { data: reportRow, error: reportErr } = await sb
    .from(AP_SCORE_REPORTS)
    .select('report_year')
    .eq('student_sheet_id', sheetId)
    .eq('report_year', reportYear)
    .maybeSingle();
  if (reportErr) return Response.json({ error: reportErr.message }, { status: 500 });

  if (reportRow) {
    const { data: entries, error: entriesErr } = await sb
      .from(STUDENT_AP_SCORES)
      .select('exam_name, score, no_exam_taken')
      .eq('student_sheet_id', sheetId)
      .eq('report_year', reportYear)
      .order('created_at', { ascending: true });
    if (entriesErr) return Response.json({ error: entriesErr.message }, { status: 500 });
    return Response.json({
      submittedThisYear: true,
      entries: (entries || []).map((e) => ({
        examName: e.exam_name,
        score: e.score,
        noExamTaken: e.no_exam_taken,
      })),
    });
  }

  const gradeYear = gradeYearJustCompleted(gradYear, nowLA);
  const detectedCourses = await getDetectedApCourses(sheets, sheetId, gradeYear);
  return Response.json({
    submittedThisYear: false,
    detectedCourses,
    subjectOptions: AP_SUBJECTS,
  });
}

export async function POST(request) {
  const resolved = await resolveStudent();
  if (resolved.error) return resolved.error;
  const { sheetId } = resolved;

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const rawEntries = Array.isArray(body?.entries) ? body.entries : [];

  // Validate + normalize, deduping by exam name (case-insensitive).
  const seen = new Set();
  const entries = [];
  for (const e of rawEntries) {
    const examName = String(e?.examName ?? '').trim();
    if (!examName) continue;
    const key = examName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (e?.noExamTaken) {
      entries.push({ examName, score: null, noExamTaken: true });
    } else {
      const score = Number(e?.score);
      if (!Number.isInteger(score) || score < 1 || score > 5) {
        return Response.json(
          { error: `Invalid score for "${examName}" — must be 1-5 or N/A` },
          { status: 400 }
        );
      }
      entries.push({ examName, score, noExamTaken: false });
    }
  }

  const nowLA = DateTime.now().setZone(ZONE);
  const reportYear = nowLA.year;
  const sb = getSupabaseClient();

  // One-shot-per-year gate, enforced server-side (not just the client hiding the form).
  const { data: existing, error: existingErr } = await sb
    .from(AP_SCORE_REPORTS)
    .select('report_year')
    .eq('student_sheet_id', sheetId)
    .eq('report_year', reportYear)
    .maybeSingle();
  if (existingErr) return Response.json({ error: existingErr.message }, { status: 500 });
  if (existing) return Response.json({ error: 'Already reported for this year' }, { status: 409 });

  if (entries.length) {
    const { error: insertErr } = await sb.from(STUDENT_AP_SCORES).insert(
      entries.map((e) => ({
        student_sheet_id: sheetId,
        exam_name: e.examName,
        score: e.score,
        no_exam_taken: e.noExamTaken,
        report_year: reportYear,
      }))
    );
    if (insertErr) return Response.json({ error: insertErr.message }, { status: 500 });
  }

  const { error: markErr } = await sb
    .from(AP_SCORE_REPORTS)
    .insert({ student_sheet_id: sheetId, report_year: reportYear });
  if (markErr) return Response.json({ error: markErr.message }, { status: 500 });

  // Best-effort mirror into the student's own sheet — a write-scoped client,
  // separate from the readonly one identity resolution uses. Never fails the
  // request; Supabase above is already the authoritative record.
  try {
    const writeAuth = getServiceAuth();
    const writeSheets = google.sheets({ version: 'v4', auth: writeAuth });
    const scored = entries.filter((e) => !e.noExamTaken);
    await writeApScoresToStudentInfo(writeSheets, sheetId, scored, nowLA);
  } catch (err) {
    console.error('apScores POST: sheet mirror failed', err);
  }

  return Response.json({ success: true });
}
