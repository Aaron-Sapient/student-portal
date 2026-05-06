import { google } from 'googleapis';
import { DateTime } from 'luxon';
import { requireDeveloper } from '@/lib/developerAuth';

const MASTER_SHEET_ID = '1YJK05oU_12wX0qK-vTqJJfaS8eVI7JMzdGP0gVso1G4';
const MASTER_TAB = '👩‍🎓 All Data';
const REPORTS_TAB = 'WrittenReports';
const STUDENT_REPORTS_TAB = 'Written Reports';

const FIELD_TO_COL = {
  onTarget: 'C',
  needsAttention: 'D',
  strategy: 'E',
  parentRequests: 'F',
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
    const sheets = google.sheets({ version: 'v4', auth: getServiceAuth() });
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: MASTER_SHEET_ID,
      range: `${REPORTS_TAB}!A:G`,
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    const rows = res.data.values || [];
    const reports = rows.slice(1)
      .map((r, i) => ({
        rowIndex: i + 2,
        date: r[0] || '',
        student: r[1] || '',
        onTarget: r[2] || '',
        needsAttention: r[3] || '',
        strategy: r[4] || '',
        parentRequests: r[5] || '',
        status: r[6] === true || r[6] === 'TRUE' || r[6] === 'true',
      }))
      .filter(r => r.student)
      .sort((a, b) => String(b.date).localeCompare(String(a.date)));
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
    const { rowIndex, field, value } = await request.json();
    if (!rowIndex || rowIndex < 2) return Response.json({ error: 'Invalid rowIndex' }, { status: 400 });
    const col = FIELD_TO_COL[field];
    if (!col) return Response.json({ error: 'Invalid field' }, { status: 400 });

    const sheets = google.sheets({ version: 'v4', auth: getServiceAuth() });
    await sheets.spreadsheets.values.update({
      spreadsheetId: MASTER_SHEET_ID,
      range: `${REPORTS_TAB}!${col}${rowIndex}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[value || '']] },
    });
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
    const { rowIndex } = await request.json();
    if (!rowIndex || rowIndex < 2) return Response.json({ error: 'Invalid rowIndex' }, { status: 400 });

    const sheets = google.sheets({ version: 'v4', auth: getServiceAuth() });

    // 1. Read the report row from master.
    const reportRes = await sheets.spreadsheets.values.get({
      spreadsheetId: MASTER_SHEET_ID,
      range: `${REPORTS_TAB}!A${rowIndex}:G${rowIndex}`,
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    const row = reportRes.data.values?.[0];
    if (!row) return Response.json({ error: 'Report row not found' }, { status: 404 });
    const [date, student, onTarget, needsAttention, strategy, parentRequests] = row;
    if (!student) return Response.json({ error: 'Report row has no student name' }, { status: 400 });

    // Master sheet stores serial dates; convert back to ISO for the student sheet.
    const dateIso = (typeof date === 'number')
      ? DateTime.fromMillis((date - 25569) * 86400 * 1000).toISO()
      : (date || DateTime.now().toISO());

    // 2. Look up the student sheet ID by name (col A) → URL (col G).
    const masterRes = await sheets.spreadsheets.values.get({
      spreadsheetId: MASTER_SHEET_ID,
      range: `${MASTER_TAB}!A:G`,
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    const masterRows = masterRes.data.values || [];
    const studentRow = masterRows.find(r => r[0] === student);
    if (!studentRow) {
      return Response.json({ error: `Student "${student}" not found in master sheet` }, { status: 404 });
    }
    const studentSheetUrl = studentRow[6];
    const sheetIdMatch = studentSheetUrl?.match?.(/\/d\/([a-zA-Z0-9-_]+)/);
    if (!sheetIdMatch) {
      return Response.json({ error: `Could not parse sheet URL for "${student}"` }, { status: 400 });
    }
    const studentSheetId = sheetIdMatch[1];

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

    // 6. Flip Status to TRUE in the master.
    await sheets.spreadsheets.values.update({
      spreadsheetId: MASTER_SHEET_ID,
      range: `${REPORTS_TAB}!G${rowIndex}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[true]] },
    });

    return Response.json({ success: true });
  } catch (err) {
    console.error('writtenReports POST error:', err);
    return Response.json({ error: err.message || 'Server error' }, { status: 500 });
  }
}
