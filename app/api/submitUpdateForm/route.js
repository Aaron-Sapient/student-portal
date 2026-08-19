import { auth } from '@clerk/nextjs/server';
import { google } from 'googleapis';
import { DateTime } from 'luxon';
import Anthropic from '@anthropic-ai/sdk';
import { triggerReportGeneration } from '@/lib/generateReport';
import { listBlocksForBooking, isDateBlocked } from '@/lib/blocks';
import { getProjectRows, toLADate } from '@/lib/projects';
import { sendMeetingGrantedEmail } from '@/lib/checkinEmails';
import { getSeniorBySheetId, createCheckinGrant } from '@/lib/seniors';
import { setBookingToken, resolveStudentSheetId } from '@/lib/bookingTokens';

const MASTER_SHEET_ID = '1YJK05oU_12wX0qK-vTqJJfaS8eVI7JMzdGP0gVso1G4';
const MASTER_TAB = '👩‍🎓 All Data';
const CHECKIN_TAB = 'CheckinForm';

function getServiceAuth() {
  return new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

// Convert letter grade to GPA points
function gradeToPoints(grade) {
  const map = {
    'A+': 4.0, 'A': 4.0, 'A-': 3.7,
    'B+': 3.3, 'B': 3.0, 'B-': 2.7,
    'C+': 2.3, 'C': 2.0, 'C-': 1.7,
    'D+': 1.3, 'D': 1.0, 'D-': 0.7,
    'F': 0.0,
  };
  return map[grade] ?? null;
}

// Build a grade snapshot string: "English: A+, Biology: B-"
function buildGradeSnapshot(classes, grades) {
  return classes
    .map((cls, i) => grades[i] ? `${cls.name}: ${grades[i]}` : null)
    .filter(Boolean)
    .join(', ');
}

// Parse a grade snapshot string back into an object { className: grade }
function parseGradeSnapshot(snapshot) {
  if (!snapshot) return {};
  return Object.fromEntries(
    snapshot.split(',').map(s => {
      const [name, grade] = s.split(':').map(x => x.trim());
      return [name, grade];
    })
  );
}

// Detect grade drops between two snapshots
function detectGradeDrops(previousSnapshot, currentSnapshot) {
  const drops = [];
  for (const [cls, currentGrade] of Object.entries(currentSnapshot)) {
    const prevGrade = previousSnapshot[cls];
    if (!prevGrade || !currentGrade) continue;
    const prevPoints = gradeToPoints(prevGrade);
    const currPoints = gradeToPoints(currentGrade);
    if (prevPoints !== null && currPoints !== null && currPoints < prevPoints) {
      drops.push({
        class: cls,
        from: prevGrade,
        to: currentGrade,
        drop: +(prevPoints - currPoints).toFixed(1),
        isSignificant: (prevPoints - currPoints) >= 1.0, // one full letter or more
        isDanger: currPoints <= 1.0, // D or F
      });
    }
  }
  return drops;
}

// Calculate unweighted GPA from current grade snapshot
function calculateGPA(snapshot) {
  const points = Object.values(snapshot)
    .map(g => gradeToPoints(g))
    .filter(p => p !== null);
  if (!points.length) return null;
  return +(points.reduce((a, b) => a + b, 0) / points.length).toFixed(2);
}

export async function POST(request) {
  const { sessionClaims } = await auth();
  const email = sessionClaims?.email;
  if (!email) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const body = await request.json();
    const {
      grades,           // [{ rowOffset, grade }]
      studentSheetId,
      gradesRange,
      studentRowIndex,
      studentName,
      classes,          // [{ name, grade, rowOffset }] — need names for snapshot
      testsAndDeadlines,
      actionItemStatuses, // [{ task, status }]
      questionsCategory,
      questionsText,
      selfRating,
      responsePreference,
    } = body;

    // Seniors do a record-only weekly check-in: it's the deterministic prerequisite
    // that unlocks their booking for the week (no Claude eval, no token, no Ryan
    // approval email, no report). We still write grades + the AY timestamp + the
    // CheckinForm row, then return early before the urgency-evaluation machinery.
    // Determine senior-ness SERVER-SIDE — never trust the client's body.senior flag.
    // A stale/confused client (Bella Huang, 2026-07-14) once sent body.senior=false and
    // routed a senior down the NON-senior path, silently skipping the check-in grant that
    // unlocks their booking. Key off the LIVE studentSheetId (Master col G) — the SAME key
    // home-data uses to route the student to the senior UI and that getActiveGrant reads the
    // grant back by — so routing, this authority, and the grant write can't disagree, and the
    // grant always lands under the id every downstream read uses. body.senior is a fallback
    // ONLY when the roster lookup itself errors (so a transient Supabase blip can't break an
    // ordinary non-senior check-in, which needs no Supabase). NOTE: this does not touch the
    // separate, pre-existing key mismatch where validateBooking/bookMeeting resolve seniors by
    // EMAIL rather than sheetId — that's unchanged here and worth a follow-up.
    let seniorRow = null;
    let seniorLookupOk = true;
    try {
      seniorRow = studentSheetId ? await getSeniorBySheetId(studentSheetId) : null;
    } catch (lookupErr) {
      seniorLookupOk = false;
      console.error('[checkin] senior roster lookup failed; falling back to client hint:', lookupErr?.message);
    }
    const isSenior = seniorLookupOk ? !!seniorRow : body.senior === true;

    const authClient = getServiceAuth();
    const sheets = google.sheets({ version: 'v4', auth: authClient });

    // ── 1. Write grades back to student Transcript tab ──────────────────────
    if (grades?.length && gradesRange && studentSheetId) {
      const rangeMatch = gradesRange.match(/^(.+)!([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
      if (rangeMatch) {
        const [, tab, col, startRow] = rangeMatch;
        const startRowNum = parseInt(startRow);
        const gradeData = grades.map(({ rowOffset, grade }) => ({
          range: `${tab}!${col}${startRowNum + rowOffset}`,
          values: [[grade || '']],
        }));
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: studentSheetId,
          requestBody: { valueInputOption: 'USER_ENTERED', data: gradeData },
        });
      }
    }

    const now = new Date().toISOString();

    // ── 2. Stamp the check-in timestamp(s) in 👩‍🎓 All Data ──────────────────
    // AY = Ryan/primary check-in. SENIORS are a unified program with ONE weekly
    // check-in instead of separate Ryan + Aaron tracks, so we also stamp BA
    // (Aaron's column). The Friday reminder checker — and the dev Compliance
    // dashboard that mirrors it — count a student "engaged" only when BOTH AY
    // and BA are recent; without the BA stamp a senior who just checked in still
    // gets a "reconnect with Aaron" nudge, because BA never moves for them (they
    // have no separate Aaron check-in). Keep both columns in lockstep for seniors.
    // See Google Apps Scripts/checkin-reminder/checkinReminder.gs.
    // Non-seniors are stamped LATER, after the booking token lands (step 7):
    // AY is what the portal reads as "you're checked in for the week", so it
    // must never say done while the decision write failed — a student stuck in
    // that state would see a confirmation and silently get no token, no eval,
    // and no report. Failing the other way (token written, AY stamp failed)
    // just lets them re-submit, which supersedes harmlessly.
    if (isSenior) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: MASTER_SHEET_ID,
        requestBody: {
          valueInputOption: 'USER_ENTERED',
          data: [
            { range: `${MASTER_TAB}!AY${studentRowIndex}`, values: [[now]] },
            { range: `${MASTER_TAB}!BA${studentRowIndex}`, values: [[now]] },
          ],
        },
      });
    }

    // ── 3. Build concatenated strings for CheckinForm ────────────────────────
    const gradeSnapshot = classes?.length
      ? buildGradeSnapshot(classes, grades.map(g => g.grade))
      : '';

    const actionItemsString = (actionItemStatuses || [])
      .map(({ task, status }) => `${task}: ${status}`)
      .join('; ');

    // ── 4. Append new row to CheckinForm ─────────────────────────────────────
    // Column order: A=Timestamp, B=Name, C=Grades, D=Tests&Deadlines,
    // E=Task Updates, F=Q/C Category, G=Q/C Text, H=Self-Rating, I=Response Pref
    await sheets.spreadsheets.values.append({
      spreadsheetId: MASTER_SHEET_ID,
      range: `${CHECKIN_TAB}!A:I`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [[
          now,                      // A: Timestamp
          studentName || '',        // B: Name
          gradeSnapshot,            // C: Grades (concatenated)
          testsAndDeadlines || '',  // D: Tests & Deadlines
          actionItemsString || '',  // E: Task Updates (concatenated)
          questionsCategory || '',  // F: Questions/Concerns Category
          questionsText || '',      // G: Questions/Concerns Text
          selfRating || '',         // H: Self-Rating
          responsePreference || '', // I: Response Preference
        ]],
      },
    });

    // Senior check-in is record-only — but it ALSO grants this week's booking
    // tokens (one week's worth, spendable across the current+next Saturday-week).
    // The grant is the auditable record that unlocks booking; a new check-in
    // supersedes the prior grant. See lib/seniors.js createCheckinGrant.
    if (isSenior) {
      try {
        // seniorRow is set in the common path (email lookup succeeded). If isSenior
        // came from the client-hint fallback (lookup errored), resolve it by sheetId.
        const senior = seniorRow || (await getSeniorBySheetId(studentSheetId));
        if (!senior) throw new Error(`senior unresolved (email=${email}, sheetId=${studentSheetId})`);
        await createCheckinGrant(senior, DateTime.now().setZone('America/Los_Angeles'));
      } catch (grantErr) {
        console.error('Failed to write senior check-in grant:', grantErr);
        return Response.json({ error: 'Check-in saved, but unlocking booking failed. Please retry.' }, { status: 500 });
      }
      return Response.json({ success: true, senior: true });
    }

    // ── 5. Fetch grade history (last 3 submissions) for AI context ───────────
    const checkinRes = await sheets.spreadsheets.values.get({
      spreadsheetId: MASTER_SHEET_ID,
      range: `${CHECKIN_TAB}!A:I`,
      valueRenderOption: 'UNFORMATTED_VALUE',
    });

    const allCheckins = checkinRes.data.values || [];
    // Filter to this student's rows (col B = name), skip header if present
    const studentCheckins = allCheckins
      .filter(r => r[1] === studentName)
      .slice(-4, -1); // last 3 before current submission

    const gradeHistory = studentCheckins.map(r => ({
      timestamp: r[0],
      snapshot: parseGradeSnapshot(r[2]),
    }));

    // Current snapshot
    const currentSnapshot = parseGradeSnapshot(gradeSnapshot);
    const currentGPA = calculateGPA(currentSnapshot);

    // Grade drops vs most recent previous submission
    const mostRecent = gradeHistory[gradeHistory.length - 1];
    const gradeDrops = mostRecent
      ? detectGradeDrops(mostRecent.snapshot, currentSnapshot)
      : [];

    // ── 5b. Summer-timeline context ─────────────────────────────────────────
    // The student's active 🏆 Comps & Projects (deadlines / % complete) are the
    // in-sheet mirror of their summer timeline, so Claude can weigh urgency
    // against where their projects actually stand. Best-effort: eval proceeds
    // without it if the read fails.
    let timelineText = 'No active projects on record.';
    try {
      if (studentSheetId) {
        // Flag-gated 🏆 Comps & Projects rows (Sheets today). E:N is a superset of
        // the old E:L read; the indices used below (0,3,4,6) are unchanged.
        const projectRows = await getProjectRows(sheets, studentSheetId);
        // Uses lib/projects.js's toLADate — the same parser getProjectRows itself uses
        // for these columns. The previous inline copy used native Date, which renders a
        // Sheets serial in the SERVER's zone: correct on Vercel (UTC), a day early
        // anywhere behind it.
        const fmtDate = (raw) => {
          const d = toLADate(raw);
          return d ? d.toFormat('LLL d') : (raw === '' || raw == null ? '' : String(raw));
        };
        const pct = (raw) => {
          if (raw === '' || raw == null) return null;
          const n = typeof raw === 'number' ? raw : parseFloat(String(raw).replace('%', ''));
          if (!Number.isFinite(n)) return null;
          return n > 0 && n <= 1 ? Math.round(n * 100) : Math.round(n);
        };
        const active = (projectRows || [])
          .slice(1)
          .filter((r) => r[6] === '🟢' || r[6] === '✅')
          .map((r) => ({ activity: r[0] || '', deadline: fmtDate(r[3]), pct: pct(r[4]), status: r[6] || '' }))
          .filter((p) => p.activity);
        if (active.length) {
          timelineText = active
            .map((p) => `- ${p.activity}: ${p.pct == null ? '?' : p.pct}% complete${p.deadline ? `, deadline ${p.deadline}` : ''} (${p.status})`)
            .join('\n');
        }
      }
    } catch (projErr) {
      console.error('submitUpdateForm: project context fetch failed', projErr);
    }

    // ── 6. Urgency evaluation ────────────────────────────────────────────────
    // Outcome is 'written' (no meeting — generate a report) or 'granted' (the
    // evaluator writes the booking token itself and the student books directly).
    // No human approval step exists: D1 = Option A (Aaron, 2026-08-19) — no
    // booking path may wait on a person clicking something (SUMMER-EXIT.md).
    let outcome = 'written';
    let suggestedLength = '15min';
    let reason = '';
    let skipClaude = false;

    // Block override: Ryan unavailable today → straight to a written report.
    const today = DateTime.now().setZone('America/Los_Angeles').toFormat('yyyy-LL-dd');
    const blocks = await listBlocksForBooking();
    if (isDateBlocked(blocks, 'ryan', today)) {
      outcome = 'written';
      reason = 'Ryan is unavailable today — routed to a written report.';
      skipClaude = true;
    }

    const currentGradesText = Object.entries(currentSnapshot).length
      ? Object.entries(currentSnapshot).map(([cls, g]) => `${cls}: ${g}`).join(', ')
      : 'No grade data (summer / MS student).';

    const gradeDropsText = gradeDrops.length
      ? gradeDrops
          .map((d) => `${d.class}: ${d.from} → ${d.to}${d.isDanger ? ' (now D/F territory)' : d.isSignificant ? ' (a full letter or more)' : ''}`)
          .join('; ')
      : 'None detected.';

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // Seasonal gate — same June–August window as isSummer() in the check-in
    // forms and the checkinReminder.gs summer exception, so the prompt can never
    // contradict what the form is asking. Before this, the prompt hardcoded
    // "IT IS SUMMER" and would have asserted it forever (SUMMER-EXIT.md).
    const laMonth = DateTime.now().setZone('America/Los_Angeles').month;
    const isSummerNow = laMonth >= 6 && laMonth <= 8;
    const seasonContext = isSummerNow
      ? `CONTEXT — IT IS SUMMER. Meetings are as-needed, not weekly; a written update is the healthy default for routine check-ins. Students used to a weekly cadence over-request out of habit — do not cater to habit for vague or low-content check-ins.`
      : `CONTEXT — IT IS THE SCHOOL YEAR. Check-ins are weekly and include grades. A written update is still the right default for a routine, on-track week, but academic signals now carry real weight: a genuine grade drop, an approaching test or application deadline the student is anxious about, or schoolwork stress paired with a request to talk all favor a meeting.`;

    const systemPrompt = `You decide whether a student's WEEKLY check-in earns a meeting with their counselor Ryan.

IMPORTANT: setting meeting = true GRANTS the meeting — the student is immediately emailed a booking link. No human reviews this decision. The costs are asymmetric: a wrong "true" costs Ryan one short meeting that maybe wasn't strictly needed; a wrong "false" SILENTLY denies a student with no human ever seeing the request. When an explicit, substantiated request is involved, lean true.

${seasonContext}

Set meeting = TRUE when ANY of these hold:
- The concern category is "Need to Discuss" AND the concern text names at least one real topic, question, or issue (i.e. it is not blank or a throwaway). An explicit, substantiated request to discuss ALWAYS goes to Ryan. A good self-rating does NOT override this — the self-rating is how their week went, not whether they need to talk something through.
- A low self-rating (1–3) paired with any concrete stressor.
- An active project clearly behind schedule (well under 50% with a deadline approaching) where the student signals they are stuck or off-track.
- A genuinely complex or multi-part question that writing cannot resolve well.

Set meeting = FALSE (written report) when:
- The concern category is "None" or blank.
- The category is "Quick Question" (or "Need to Discuss" with empty/throwaway text) AND none of the TRUE conditions above are triggered — a routine status update a written reply handles fine.
- A quiet, on-track week with a mid-to-high self-rating and no explicit, substantiated request to discuss.

A mid-to-high self-rating (4–10) is NEVER, by itself, a reason to deny an explicit "Need to Discuss" request with real content.

If meeting = true, set suggestedLength: "30min" only for genuinely complex or multi-issue situations; otherwise "15min". (This is the length the student is granted.)

Respond with ONLY a JSON object — no markdown, no extra text:
{"meeting": true|false, "suggestedLength": "15min"|"30min", "reason": "one-sentence justification addressed to Ryan"}`;

    const userMessage = `Student: ${studentName}

WEEK SELF-RATING (how'd the week go, 1-10): ${selfRating}/10

QUESTIONS/CONCERNS:
Category: ${questionsCategory || 'None'}
Details: ${questionsText || 'N/A'}

TESTS & DEADLINES THEY REPORTED:
${testsAndDeadlines || 'None reported'}

TASK UPDATES:
${actionItemStatuses?.map(({ task, status }) => `- ${task}: ${status}`).join('\n') || 'None reported'}

PROJECT TIMELINE (active Comps & Projects — weigh urgency against these):
${timelineText}

CURRENT GRADES: ${currentGradesText}
GRADE CHANGES vs LAST CHECK-IN: ${gradeDropsText}`;

    if (!skipClaude) {
      try {
        const aiResponse = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 150,
          system: systemPrompt,
          messages: [{ role: 'user', content: userMessage }],
        });
        const rawText = aiResponse.content[0]?.text || '{}';
        console.log('AI raw response:', rawText);
        const cleaned = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();
        const parsed = JSON.parse(cleaned);
        outcome = parsed.meeting === true ? 'granted' : 'written';
        suggestedLength = parsed.suggestedLength === '30min' ? '30min' : '15min';
        reason = parsed.reason || reason;
      } catch (aiErr) {
        // Fail safe: on any model/parse failure, default to a written report
        // rather than emailing Ryan an unjustified meeting request.
        console.error('submitUpdateForm: eval failed, defaulting to written', aiErr);
        outcome = 'written';
        reason = reason || 'Could not evaluate urgency — defaulted to a written report.';
      }
    }

    // decision: '15min'/'30min' = a live booking token; 'written' = no meeting.
    const decision = outcome === 'granted' ? suggestedLength : 'written';

    // ── 7. Write the booking token (authoritative: Supabase booking_tokens) ──
    // The Master AZ cell is deliberately NOT written anymore — the booking
    // outcome lives in the database, not the sheet. Fail loudly: a grant that
    // doesn't land is a stranded student, not a cosmetic miss.
    const tokenSheetId = studentSheetId || (await resolveStudentSheetId(sheets, studentRowIndex));
    await setBookingToken({ studentSheetId: tokenSheetId, slug: 'ryan', value: decision });

    // Decision landed — NOW mark the week's check-in done (see the note at step 2).
    await sheets.spreadsheets.values.update({
      spreadsheetId: MASTER_SHEET_ID,
      range: `${MASTER_TAB}!AY${studentRowIndex}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[now]] },
    });

    // ── 8. Stamp the just-appended CheckinForm row: K=reason, L=status ────────
    const allRowsRes = await sheets.spreadsheets.values.get({
      spreadsheetId: MASTER_SHEET_ID,
      range: `${CHECKIN_TAB}!A:L`,
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    const checkinRows = allRowsRes.data.values || [];
    let lastMatchIndex = -1;
    checkinRows.forEach((r, i) => { if (r[1] === studentName) lastMatchIndex = i; });
    const checkinRow = lastMatchIndex + 1; // 1-based sheet row of this submission

    if (lastMatchIndex > -1) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: MASTER_SHEET_ID,
        requestBody: {
          valueInputOption: 'USER_ENTERED',
          data: [
            { range: `${CHECKIN_TAB}!K${checkinRow}`, values: [[reason || '']] },
            { range: `${CHECKIN_TAB}!L${checkinRow}`, values: [[decision]] },
          ],
        },
      });
    }

    // ── 9. Act on the outcome ────────────────────────────────────────────────
    if (outcome === 'granted') {
      // Email the student (CC parents) the booking link. Best-effort — the
      // token is already written, so the student can also book straight from
      // the portal (the check-in confirmation screen links there).
      try {
        const emailsRes = await sheets.spreadsheets.values.get({
          spreadsheetId: MASTER_SHEET_ID,
          range: `${MASTER_TAB}!J${studentRowIndex}:L${studentRowIndex}`,
          valueRenderOption: 'UNFORMATTED_VALUE',
        });
        const row = emailsRes.data.values?.[0] || [];
        const studentEmail = String(row[0] || '').trim();
        const parentEmails = [row[1], row[2]].map((e) => String(e || '').trim()).filter(Boolean);
        if (studentEmail) {
          await sendMeetingGrantedEmail({ studentEmail, parentEmails, studentName, decision });
        }
      } catch (mailErr) {
        console.error('submitUpdateForm: failed to send grant email', mailErr);
      }
    } else if (outcome === 'written') {
      const start = Date.now();
      await triggerReportGeneration(studentName, studentSheetId);
      console.log('Report generation took', Date.now() - start, 'ms');
    }

    return Response.json({ success: true, outcome, decision, reason });

  } catch (err) {
    console.error('submitUpdateForm error:', err);
    return Response.json({ error: err.message || 'Server error' }, { status: 500 });
  }
}
