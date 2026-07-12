import { google } from 'googleapis';
import { DateTime } from 'luxon';
import { requireAdmin } from '@/lib/developerAuth';
import { getInstructor } from '@/lib/instructors';
import { getSeniorBySheetId, createOneoffGrant } from '@/lib/seniors';
import { sendMeetingGrantedEmail } from '@/lib/checkinEmails';
import { getSupabaseClient, MEETING_CAP_SUMMARY } from '@/lib/supabase';

// Admin tool: grant a student a ONE-OFF meeting that bypasses the weekly check-in
// gate and unlocks booking in their Meetings tab. Two tracks, auto-detected:
//   • Regular student → write the booking token to Master col AZ (Ryan) / BB (Aaron),
//     exactly like a check-in grant would. For Ryan, bump the monthly cap so the
//     extra meeting isn't capped out.
//   • Senior (Class-of-2027 essay program) → a SEPARATE additive one-off grant row
//     (senior_oneoff_grants); never touches their deterministic weekly cadence.
// Then email the student (CC parents) a booking link. requireAdmin → Ryan + Aaron.

const MASTER_SHEET_ID = '1YJK05oU_12wX0qK-vTqJJfaS8eVI7JMzdGP0gVso1G4';
const MASTER_TAB = '👩‍🎓 All Data';
const CHECKINS_TAB = '✅ Check-Ins';

// How long a senior's one-off stays bookable (LA calendar days from today).
const ONEOFF_WINDOW_DAYS = 14;

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
  const gate = await requireAdmin();
  if (!gate.ok) return gate.response;

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { studentSheetId, instructor: instructorSlug, minutes, note } = body;
  if (!studentSheetId) return Response.json({ error: 'Missing studentSheetId' }, { status: 400 });

  const slug = String(instructorSlug || '').toLowerCase();
  if (slug !== 'ryan' && slug !== 'aaron') {
    return Response.json({ error: 'Instructor must be ryan or aaron' }, { status: 400 });
  }
  const mins = parseInt(minutes, 10);
  if (mins !== 15 && mins !== 30) {
    return Response.json({ error: 'Minutes must be 15 or 30' }, { status: 400 });
  }
  const instructor = getInstructor(slug);

  try {
    const authClient = getServiceAuth();
    const sheets = google.sheets({ version: 'v4', auth: authClient });

    // Resolve the student from the Master sheet by sheet id (portal URL, col G).
    const masterRes = await sheets.spreadsheets.values.get({
      spreadsheetId: MASTER_SHEET_ID,
      range: `${MASTER_TAB}!A:L`,
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    const rows = masterRes.data.values || [];
    const rowIdx = rows.findIndex((r) => String(r[6] || '').includes(studentSheetId));
    const row = rowIdx >= 0 ? rows[rowIdx] : null;
    const rowIndex = rowIdx + 1; // 1-based sheet row

    const senior = await getSeniorBySheetId(studentSheetId);

    // Identity for the email (Master cols A=name, J=email, K/L=parent emails). Fall
    // back to the seniors row for a senior whose Master row didn't resolve.
    const studentName = (row?.[0] || senior?.student_name || '').trim();
    const studentEmail = (row?.[9] || senior?.student_email || '').trim();
    const parentEmails = [row?.[10], row?.[11]].filter((e) => e && String(e).includes('@'));

    if (!senior && !row) {
      return Response.json({ error: 'Student not found in the Master sheet' }, { status: 404 });
    }

    let kind;
    let detail;

    if (senior) {
      // Separate, additive track — does not touch the weekly cadence.
      const today = DateTime.now().setZone('America/Los_Angeles').startOf('day');
      const through = today.plus({ days: ONEOFF_WINDOW_DAYS });
      await createOneoffGrant(senior, {
        teacher: slug,
        minutes: mins,
        from: today.toISODate(),
        through: through.toISODate(),
        note: note?.trim() || null,
        grantedBy: gate.email,
      });
      kind = 'senior';
      detail = `extra meeting · bookable through ${through.toFormat('LLL d')}`;
    } else {
      // Regular student — write the booking token (bypasses the check-in gate).
      await sheets.spreadsheets.values.update({
        spreadsheetId: MASTER_SHEET_ID,
        range: `${MASTER_TAB}!${instructor.masterColumn}${rowIndex}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[`${mins}min`]] },
      });
      kind = 'regular';
      detail = 'booking unlocked';

      // Ryan's monthly cap (✅ Check-Ins cols H=used, I=allowed) would otherwise
      // block an extra meeting once the student is at their limit. Lift it by one so
      // the one-off is genuinely bookable. Best-effort; never fail the grant on this.
      if (slug === 'ryan' && studentName) {
        try {
          const capRes = await sheets.spreadsheets.values.get({
            spreadsheetId: MASTER_SHEET_ID,
            range: `${CHECKINS_TAB}!A:I`,
            valueRenderOption: 'UNFORMATTED_VALUE',
          });
          const capRows = capRes.data.values || [];
          const capIdx = capRows.findIndex((r) => r[0] === studentName);
          if (capIdx >= 0) {
            const used = parseInt(capRows[capIdx][7], 10) || 0;
            const allowedRaw = capRows[capIdx][8];
            const allowed = allowedRaw === '' || allowedRaw === undefined ? null : parseInt(allowedRaw, 10);
            if (allowed !== null && used >= allowed) {
              await sheets.spreadsheets.values.update({
                spreadsheetId: MASTER_SHEET_ID,
                range: `${CHECKINS_TAB}!I${capIdx + 1}`,
                valueInputOption: 'USER_ENTERED',
                requestBody: { values: [[used + 1]] },
              });
              detail = 'booking unlocked · monthly cap lifted +1';

              // Best-effort mirror to the compliance_cap cutover table (Bucket-A;
              // read side stays on Sheets for now — see lib/supabase.js). Never
              // block the grant on this.
              try {
                const sb = getSupabaseClient();
                const { error: mirrorErr } = await sb
                  .from(MEETING_CAP_SUMMARY)
                  .upsert({ student_sheet_id: studentSheetId, meetings_allowed: used + 1 }, { onConflict: 'student_sheet_id' });
                if (mirrorErr) console.warn('grantBooking: meeting_cap_summary mirror failed (non-fatal):', mirrorErr.message);
              } catch (mirrorErr) {
                console.warn('grantBooking: meeting_cap_summary mirror threw (non-fatal):', mirrorErr.message);
              }
            }
          }
        } catch (capErr) {
          console.error('grantBooking: cap bump failed (non-fatal):', capErr);
        }
      }
    }

    // Email the student (CC parents) a booking link. Best-effort — the grant itself
    // already succeeded above, so a mail failure shouldn't 500 the request.
    let emailed = false;
    if (studentEmail) {
      try {
        await sendMeetingGrantedEmail({
          studentEmail,
          parentEmails,
          studentName,
          decision: `${mins}min`,
          instructorSlug: slug,
          instructorName: instructor.displayName,
          reason: note?.trim() || 'a one-off meeting set up for you',
        });
        emailed = true;
      } catch (emailErr) {
        console.error('grantBooking: email failed (non-fatal):', emailErr);
      }
    }

    return Response.json({
      ok: true,
      kind,
      studentName,
      instructorName: instructor.displayName,
      minutes: mins,
      emailed,
      message:
        `Granted ${studentName || 'student'} a ${mins}-min one-off with ${instructor.displayName} ` +
        `(${kind === 'senior' ? 'senior · ' : ''}${detail}).` +
        (emailed ? ' Emailed a booking link.' : studentEmail ? ' Email failed — share the link manually.' : ' No email on file.'),
    });
  } catch (err) {
    console.error('grantBooking error:', err);
    return Response.json({ error: err.message || 'Server error' }, { status: 500 });
  }
}
