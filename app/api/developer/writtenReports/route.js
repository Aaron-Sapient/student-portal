import { google } from 'googleapis';
import { sheetSafe } from '@/lib/sheetSafe';
import { DateTime } from 'luxon';
import { requireDeveloper } from '@/lib/developerAuth';
import { getSupabaseClient, WRITTEN_REPORTS } from '@/lib/supabase';
import { getStudentContactBySheetId } from '@/lib/identity';

// The MASTER sheet id, its 👩‍🎓 All Data tab and its WrittenReports tab are gone:
// the report RECORD lives in `written_reports`. What remains below is the separate
// 'Written Reports' TAB on each STUDENT's own sheet — the family-facing delivery
// surface. It has no Supabase reader yet (written_reports.body_html is written
// NULL by the backfill and nothing reads it), so replacing it needs a portal-native
// report page. That is the next lane, deliberately not this one.
const STUDENT_REPORTS_TAB = 'Written Reports';

// Supabase (snake_case) column for each editable field — for the best-effort
// written_reports mirror dual-write (Bucket-A cutover), keyed on sheet_row.
const FIELD_TO_DBCOL = {
  onTarget: 'on_target',
  needsAttention: 'needs_attention',
  strategy: 'strategy',
  parentRequests: 'parent_requests',
};

// Mirrors the original HTML email's color palette so the student-sheet output
// looks like the report-style we used to email.
const COLOR_HEADING   = '#763F21'; // rust — for ## section labels and table header bg
const COLOR_SUBHEAD   = '#2F5034'; // dark green — for ### subsections
const COLOR_BODY      = '#111111';
const COLOR_BORDER    = '#C9C5BA';
const FONT_DISPLAY    = 'Figtree';
const FONT_BODY       = 'Bitter';

function getServiceAuth() {
  return new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

function hexToRgb(hex) {
  const c = hex.replace('#', '');
  return {
    red:   parseInt(c.slice(0, 2), 16) / 255,
    green: parseInt(c.slice(2, 4), 16) / 255,
    blue:  parseInt(c.slice(4, 6), 16) / 255,
  };
}

// Sheets serial date = days since 1899-12-30. Unix epoch is 25569 days later.
function isoToSheetSerial(iso) {
  const ms = DateTime.fromISO(iso).toMillis();
  if (!Number.isFinite(ms)) return null;
  return ms / 86400000 + 25569;
}

// ──────────────────────────────────────────────────────────────────────────────
// Markdown → Sheets rich text. Recognizes:
//   ## HEADING        → Figtree, bold+italic, 13pt, rust, uppercase
//   ### Subheading    → Figtree, italic, 12pt, dark green
//   - bullet          → "•  " prefix, body font
//   **bold** inline   → bold run within body
// Anything else renders as body text. Returns { text, textFormatRuns } in the
// shape Sheets expects for a cell with mixed formatting.
// ──────────────────────────────────────────────────────────────────────────────
function markdownToRichText(md) {
  const source = String(md ?? '');
  if (!source.trim()) return { text: '', textFormatRuns: [] };

  const bodyFmt = {
    fontFamily: FONT_BODY, fontSize: 11,
    bold: false, italic: false,
    foregroundColor: hexToRgb(COLOR_BODY),
  };
  const boldFmt = { ...bodyFmt, bold: true };
  const headingFmt = {
    fontFamily: FONT_DISPLAY, fontSize: 13,
    bold: true, italic: true,
    foregroundColor: hexToRgb(COLOR_HEADING),
  };
  const subheadFmt = {
    fontFamily: FONT_DISPLAY, fontSize: 12,
    bold: false, italic: true,
    foregroundColor: hexToRgb(COLOR_SUBHEAD),
  };

  let text = '';
  const runs = [];
  const pushRun = (start, format) => {
    // Collapse adjacent identical formats.
    const last = runs[runs.length - 1];
    if (last && JSON.stringify(last.format) === JSON.stringify(format)) return;
    runs.push({ startIndex: start, format });
  };

  // Strip trailing blank lines and leading whitespace newlines.
  const lines = source.replace(/\s+$/g, '').split('\n');

  let firstLine = true;
  for (const raw of lines) {
    if (!firstLine) text += '\n';
    firstLine = false;

    const trimmed = raw.trimEnd();

    if (/^## /.test(trimmed)) {
      pushRun(text.length, headingFmt);
      text += trimmed.slice(3).toUpperCase();
      continue;
    }
    if (/^### /.test(trimmed)) {
      pushRun(text.length, subheadFmt);
      text += trimmed.slice(4);
      continue;
    }

    // Treat list bullets uniformly as "•  …", with inline **bold** parsing.
    const bulletMatch = trimmed.match(/^[-*]\s+(.*)$/);
    const inlineSource = bulletMatch ? `•  ${bulletMatch[1]}` : trimmed;

    // Walk the line, switching between body and bold runs at every `**`.
    let cursor = 0;
    const re = /\*\*(.+?)\*\*/g;
    let match;
    let inThisLineWroteAnything = false;
    while ((match = re.exec(inlineSource))) {
      if (match.index > cursor) {
        pushRun(text.length, bodyFmt);
        text += inlineSource.slice(cursor, match.index);
        inThisLineWroteAnything = true;
      }
      pushRun(text.length, boldFmt);
      text += match[1];
      inThisLineWroteAnything = true;
      cursor = match.index + match[0].length;
    }
    if (cursor < inlineSource.length) {
      pushRun(text.length, bodyFmt);
      text += inlineSource.slice(cursor);
      inThisLineWroteAnything = true;
    }
    if (!inThisLineWroteAnything) {
      // Empty line — keep the newline we already added; ensure the next run starts fresh.
      pushRun(text.length, bodyFmt);
    }
  }

  return { text, textFormatRuns: runs };
}

// ──────────────────────────────────────────────────────────────────────────────
// Standard API handlers
// ──────────────────────────────────────────────────────────────────────────────

export async function GET() {
  const gate = await requireDeveloper();
  if (!gate.ok) return gate.response;

  try {
    // Was MASTER WrittenReports!A:H, with the 1-based sheet row as each report's
    // handle. `written_reports` is the store now and `id` (uuid) is the handle, so
    // a report is no longer addressed by its position in a spreadsheet.
    const { data, error } = await getSupabaseClient()
      .from(WRITTEN_REPORTS)
      .select('id, report_at, report_date, student_name, on_target, needs_attention, strategy, parent_requests, status, parent_notified')
      .order('report_at', { ascending: false, nullsFirst: false });
    if (error) throw new Error(error.message);

    const reports = (data || [])
      .filter((r) => r.student_name)
      .map((r) => ({
        id: r.id,
        // The sheet stored an UNFORMATTED serial and the client re-formatted it.
        // report_at is an ISO instant; report_date is the LA calendar date and is
        // what the backfilled rows carry when report_at is null.
        date: r.report_at || r.report_date || '',
        student: r.student_name || '',
        onTarget: r.on_target || '',
        needsAttention: r.needs_attention || '',
        strategy: r.strategy || '',
        parentRequests: r.parent_requests || '',
        status: r.status === true,
        parentNotified: r.parent_notified === true,
      }));
    return Response.json({ reports });
  } catch (err) {
    console.error('writtenReports GET error:', err);
    return Response.json({ error: err.message || 'Server error' }, { status: 500 });
  }
}

export async function PATCH(request) {
  const gate = await requireDeveloper();
  if (!gate.ok) return gate.response;

  try {
    const { id, field, value } = await request.json();
    if (!id || typeof id !== 'string') return Response.json({ error: 'Invalid id' }, { status: 400 });
    const dbcol = FIELD_TO_DBCOL[field];
    if (!dbcol) return Response.json({ error: 'Invalid field' }, { status: 400 });

    // Single-write. Was an authoritative sheet-cell update plus a best-effort
    // Supabase mirror keyed on sheet_row; a mirror failure was swallowed, so the
    // two could silently disagree. One store, one write, and it can fail loudly.
    const { error } = await getSupabaseClient()
      .from(WRITTEN_REPORTS)
      .update({ [dbcol]: value || null })
      .eq('id', id);
    if (error) throw new Error(error.message);

    return Response.json({ success: true });
  } catch (err) {
    console.error('writtenReports PATCH error:', err);
    return Response.json({ error: err.message || 'Server error' }, { status: 500 });
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Upload (POST): finds or creates the student-sheet "Written Reports" tab,
// styles it (hide gridlines, formatted header, frozen row, alternating bands,
// borders), appends the report as rich text, and flips Status in the master.
// ──────────────────────────────────────────────────────────────────────────────

async function ensureStudentReportsTab(sheets, studentSheetId) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: studentSheetId });
  const existing = (meta.data.sheets || []).find(s => s.properties?.title === STUDENT_REPORTS_TAB);
  if (existing) return { sheetId: existing.properties.sheetId, isNew: false };

  // Create the tab with grid props pre-set so we don't need a follow-up updateSheetProperties.
  const addRes = await sheets.spreadsheets.batchUpdate({
    spreadsheetId: studentSheetId,
    requestBody: {
      requests: [{
        addSheet: {
          properties: {
            title: STUDENT_REPORTS_TAB,
            gridProperties: { rowCount: 200, columnCount: 5, frozenRowCount: 1, hideGridlines: true },
          },
        },
      }],
    },
  });
  const sheetId = addRes.data.replies[0].addSheet.properties.sheetId;

  // Header row: bold Figtree on dark-rust background, white text, centered.
  const headers = ['Date', 'On Target', 'Needs Attention', 'Strategy & Recommendations', 'Parent Requests'];
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: studentSheetId,
    requestBody: {
      requests: [
        {
          updateCells: {
            range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 5 },
            rows: [{
              values: headers.map(h => ({
                userEnteredValue: { stringValue: h },
                userEnteredFormat: {
                  backgroundColor: hexToRgb(COLOR_HEADING),
                  horizontalAlignment: 'CENTER',
                  verticalAlignment: 'MIDDLE',
                  textFormat: {
                    fontFamily: FONT_DISPLAY, fontSize: 11,
                    bold: true,
                    foregroundColor: hexToRgb('#FFFFFF'),
                  },
                  padding: { top: 8, bottom: 8, left: 10, right: 10 },
                  wrapStrategy: 'WRAP',
                },
              })),
            }],
            fields: 'userEnteredValue,userEnteredFormat',
          },
        },
        // Reasonable column widths so the wide content cols breathe.
        ...['date', 'a', 'b', 'c', 'd'].map((_, idx) => ({
          updateDimensionProperties: {
            range: { sheetId, dimension: 'COLUMNS', startIndex: idx, endIndex: idx + 1 },
            properties: { pixelSize: idx === 0 ? 130 : 280 },
            fields: 'pixelSize',
          },
        })),
      ],
    },
  });

  return { sheetId, isNew: true };
}

async function applyTableFormatting(sheets, studentSheetId, tabSheetId, totalRows, isNewTab) {
  // 1. Borders for the entire data range (header + rows).
  const borderStyle = { style: 'SOLID', color: hexToRgb(COLOR_BORDER), width: 1 };
  const requests = [
    {
      updateBorders: {
        range: { sheetId: tabSheetId, startRowIndex: 0, endRowIndex: totalRows, startColumnIndex: 0, endColumnIndex: 5 },
        top: borderStyle, bottom: borderStyle, left: borderStyle, right: borderStyle,
        innerHorizontal: borderStyle, innerVertical: borderStyle,
      },
    },
  ];

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: studentSheetId,
    requestBody: { requests },
  });

  // 2. Try the (new-ish) Tables feature. If the API doesn't recognize addTable
  // in this environment, swallow the error — borders + frozen header + hidden
  // gridlines already give a clean table look.
  if (isNewTab) {
    try {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: studentSheetId,
        requestBody: {
          requests: [{
            addTable: {
              table: {
                name: 'WrittenReports',
                range: {
                  sheetId: tabSheetId,
                  startRowIndex: 0, endRowIndex: totalRows,
                  startColumnIndex: 0, endColumnIndex: 5,
                },
              },
            },
          }],
        },
      });
    } catch (tableErr) {
      console.warn('addTable not supported, falling back to manual formatting:', tableErr.message);
    }
  }
}

async function appendStudentReportRow(sheets, studentSheetId, tabSheetId, dateIso, sections) {
  const dateSerial = isoToSheetSerial(dateIso) ?? 0;

  const richValue = (rich) => ({
    userEnteredValue: { stringValue: rich.text || '' },
    textFormatRuns: rich.textFormatRuns?.length ? rich.textFormatRuns : undefined,
    userEnteredFormat: {
      verticalAlignment: 'TOP',
      horizontalAlignment: 'LEFT',
      wrapStrategy: 'WRAP',
      textFormat: {
        fontFamily: FONT_BODY, fontSize: 11,
        foregroundColor: hexToRgb(COLOR_BODY),
      },
      padding: { top: 10, bottom: 10, left: 10, right: 10 },
    },
  });

  const onT  = markdownToRichText(sections.onTarget);
  const need = markdownToRichText(sections.needsAttention);
  const strat = markdownToRichText(sections.strategy);
  const par  = markdownToRichText(sections.parentRequests);

  const row = {
    values: [
      {
        userEnteredValue: { numberValue: dateSerial },
        userEnteredFormat: {
          numberFormat: { type: 'DATE', pattern: 'mmmm d, yyyy' },
          horizontalAlignment: 'LEFT',
          verticalAlignment: 'TOP',
          textFormat: {
            fontFamily: FONT_BODY, fontSize: 11,
            foregroundColor: hexToRgb(COLOR_BODY),
          },
          padding: { top: 10, bottom: 10, left: 10, right: 10 },
        },
      },
      richValue(onT),
      richValue(need),
      richValue(strat),
      richValue(par),
    ],
  };

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: studentSheetId,
    requestBody: {
      requests: [{
        appendCells: {
          sheetId: tabSheetId,
          rows: [row],
          fields: 'userEnteredValue,userEnteredFormat,textFormatRuns',
        },
      }],
    },
  });
}

export async function POST(request) {
  const gate = await requireDeveloper();
  if (!gate.ok) return gate.response;

  try {
    const { id, silent } = await request.json();
    if (!id || typeof id !== 'string') return Response.json({ error: 'Invalid id' }, { status: 400 });

    const sheets = google.sheets({ version: 'v4', auth: getServiceAuth() });

    // 1. Read the report from `written_reports` (was MASTER WrittenReports!A<row>:G<row>).
    //    student_sheet_id rides on the row, so the Master A:J name lookup that used
    //    to resolve it — and could 404 a report whose stored name drifted from the
    //    roster spelling — is gone.
    const { data: report, error: readErr } = await getSupabaseClient()
      .from(WRITTEN_REPORTS)
      .select('id, student_sheet_id, student_name, on_target, needs_attention, strategy, parent_requests')
      .eq('id', id)
      .maybeSingle();
    if (readErr) throw new Error(readErr.message);
    if (!report) return Response.json({ error: 'Report not found' }, { status: 404 });

    const student = report.student_name;
    const onTarget = report.on_target || '';
    const needsAttention = report.needs_attention || '';
    const strategy = report.strategy || '';
    const parentRequests = report.parent_requests || '';
    if (!student) return Response.json({ error: 'Report has no student name' }, { status: 400 });

    const studentSheetId = report.student_sheet_id;
    if (!studentSheetId) {
      return Response.json({ error: `No student sheet on file for "${student}"` }, { status: 400 });
    }

    // Column A on the student sheet should reflect when the report was actually
    // uploaded, not when Claude originally drafted it. Force LA per project rules.
    const dateIso = DateTime.now().setZone('America/Los_Angeles').toISO();

    // The parent-notifier ping needs the student's address (was Master col J).
    const contact = await getStudentContactBySheetId(studentSheetId);
    const studentEmail = contact?.studentEmail || '';

    // 3. Tab + header (creates with hidden gridlines + frozen header + styled header).
    const { sheetId: tabSheetId, isNew } = await ensureStudentReportsTab(sheets, studentSheetId);

    // 4. Append the row as rich text + date-formatted serial.
    await appendStudentReportRow(sheets, studentSheetId, tabSheetId, dateIso, {
      onTarget, needsAttention, strategy, parentRequests,
    });

    // 5. Read back row count and apply borders (and try addTable on first upload).
    const valuesRes = await sheets.spreadsheets.values.get({
      spreadsheetId: studentSheetId,
      range: STUDENT_REPORTS_TAB,
    });
    const totalRows = (valuesRes.data.values || []).length;
    if (totalRows > 0) {
      await applyTableFormatting(sheets, studentSheetId, tabSheetId, totalRows, isNew);
    }

    // 6. Flip Status to TRUE. Single-write, keyed on the report's own id.
    {
      const { error } = await getSupabaseClient()
        .from(WRITTEN_REPORTS)
        .update({ status: true })
        .eq('id', id);
      if (error) throw new Error(`status flip failed: ${error.message}`);
    }

    // 7. Fire-and-forget the parent-notifier webhook. The Apps Script
    //    (deployed under support@admissions.partners) does its own
    //    idempotency check against col H of WrittenReports, so re-uploads
    //    won't double-notify and a failed first ping naturally retries
    //    on the next upload.
    //    Silent mode skips the ping entirely — used when we want the report
    //    in the student sheet without nudging parents.
    const webhookUrl = process.env.PARENT_NOTIFIER_WEBAPP_URL;
    const webhookToken = process.env.PARENT_NOTIFIER_TOKEN;
    if (silent) {
      console.log(`writtenReports: silent upload for "${student}" — skipping parent ping`);
    } else if (webhookUrl && webhookToken && studentEmail) {
      // sheetId + gid let the Apps Script build a deep link straight to the
      // Written Reports tab, e.g.
      //   https://docs.google.com/spreadsheets/d/<sheetId>/edit?gid=<gid>#gid=<gid>
      const url = `${webhookUrl}?token=${encodeURIComponent(webhookToken)}`
        + `&email=${encodeURIComponent(studentEmail)}`
        + `&sheetId=${encodeURIComponent(studentSheetId)}`
        + `&gid=${encodeURIComponent(tabSheetId)}`
        + `&rowIndex=${encodeURIComponent(id)}`;
      fetch(url, { method: 'GET' }).catch(e => {
        console.error('parent-notifier ping failed:', e);
      });
    } else if (!webhookUrl || !webhookToken) {
      console.warn('parent-notifier env vars missing — skipping ping');
    } else if (!studentEmail) {
      console.warn(`parent-notifier: no student email on the roster row for "${student}" — skipping ping`);
    }

    return Response.json({ success: true });
  } catch (err) {
    console.error('writtenReports POST error:', err);
    return Response.json({ error: err.message || 'Server error' }, { status: 500 });
  }
}
