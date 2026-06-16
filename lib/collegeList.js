import { DateTime } from 'luxon'

// Parsers for the student sheet's 🏫 College List + 📆 Meetings tabs.
// Pure functions over the spreadsheets.get cell grid (rowData), so they're
// testable from node without Clerk/Next. The College List tab is several
// stacked blocks in one grid; each block is located by its header marker in
// column B (or G for the school table) instead of fixed row numbers, so the
// sheet can grow without breaking the portal.

const ZONE = 'America/Los_Angeles'

const text = (c) => (c?.formattedValue ?? '').trim()
const bool = (c) => text(c).toUpperCase() === 'TRUE'

// Doc links arrive as smart chips (chipRuns) on these sheets; plain hyperlinks
// covered as a fallback.
const cellLink = (c) =>
  c?.hyperlink ||
  c?.chipRuns?.find((r) => r.chip?.richLinkProperties?.uri)?.chip.richLinkProperties.uri ||
  null

// "28%" / "2.5%" / "0.28" → 0..1 fraction; anything non-numeric → null.
const pct = (c) => {
  const raw = text(c)
  if (!raw) return null
  const n = Number(raw.replace('%', ''))
  if (Number.isNaN(n)) return null
  return raw.includes('%') ? n / 100 : n
}

const cells = (row) => row?.values || []
const findRow = (rows, col, marker) => rows.findIndex((r) => text(cells(r)[col]) === marker)

// Rows under a block header, until column `col` goes blank.
function takeBlock(rows, start, col) {
  const out = []
  for (let i = start; i < rows.length; i++) {
    if (!text(cells(rows[i])[col])) break
    out.push(cells(rows[i]))
  }
  return out
}

// Deadlines are entered as bare "11/1" / "1/2". Infer the year from the app
// cycle: the cycle "belongs" to the calendar year of its fall deadlines, so
// Jul–Dec dates land in the cycle year and Jan–Jun dates in the next one.
export function parseDeadline(raw, now = DateTime.now().setZone(ZONE)) {
  const m = String(raw).trim().match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/)
  if (!m) return null
  const month = Number(m[1])
  const day = Number(m[2])
  let year
  if (m[3]) {
    year = Number(m[3].length === 2 ? `20${m[3]}` : m[3])
  } else {
    const cycleYear = now.month >= 4 ? now.year : now.year - 1
    year = month >= 7 ? cycleYear : cycleYear + 1
  }
  const dt = DateTime.fromObject({ year, month, day }, { zone: ZONE })
  return dt.isValid ? dt.toISODate() : null
}

export function parseCollegeGrid(rows, now = DateTime.now().setZone(ZONE)) {
  // Summary block (top-left): "# of privates" / "Total progress"
  const privRow = findRow(rows, 1, '# of privates')
  const progRow = findRow(rows, 1, 'Total progress')
  const summary = {
    privatesPlanned: privRow >= 0 ? Number(text(cells(rows[privRow])[2])) || null : null,
    totalProgress: progRow >= 0 ? pct(cells(rows[progRow])[2]) : null,
  }

  // Tasks block: Task | File (chip link) | % | Notes
  const tasks = []
  const taskHdr = findRow(rows, 1, 'Task')
  if (taskHdr >= 0)
    for (const c of takeBlock(rows, taskHdr + 1, 1)) {
      tasks.push({
        name: text(c[1]),
        docTitle: text(c[2]) || null,
        docUrl: cellLink(c[2]),
        pct: pct(c[3]),
        notes: text(c[4]) || null,
      })
    }

  // PIQ block: PIQ | Choice (checkbox) | % | Notes
  const piqs = []
  const piqHdr = findRow(rows, 1, 'PIQ')
  if (piqHdr >= 0)
    for (const c of takeBlock(rows, piqHdr + 1, 1)) {
      piqs.push({
        prompt: text(c[1]),
        chosen: bool(c[2]),
        pct: pct(c[3]),
        notes: text(c[4]) || null,
      })
    }

  // School table (cols G..P): # | School Name | Status | Range | Decision |
  // Deadline | Major | Supplementals (chip → a *tab* of the supps doc) | % | Result
  // The # column runs past the filled rows, so walk it and skip placeholders.
  const schools = []
  const sHdr = findRow(rows, 6, '#')
  if (sHdr >= 0)
    for (let i = sHdr + 1; i < rows.length; i++) {
      const c = cells(rows[i])
      if (!text(c[6])) break
      const name = text(c[7])
      if (!name || name.toLowerCase() === 'pending') continue
      const dl = text(c[11])
      schools.push({
        name,
        status: text(c[8]).toLowerCase() || null,
        range: text(c[9]) || null,
        decision: text(c[10]) || null,
        deadline: /^(#|FALSE$)/i.test(dl) ? null : parseDeadline(dl, now),
        major: text(c[12]) || null,
        suppUrl: cellLink(c[13]),
        pct: pct(c[14]),
        result: text(c[15]) || null,
      })
    }

  // UC block: UC | Major | Result (one application, covered by the PIQs)
  const ucs = []
  const ucHdr = findRow(rows, 1, 'UC')
  if (ucHdr >= 0)
    for (const c of takeBlock(rows, ucHdr + 1, 1)) {
      ucs.push({ name: text(c[1]), major: text(c[2]) || null, result: text(c[3]) || null })
    }

  // Recommenders block: Writer | Subject | Year | Done
  const recommenders = []
  const recHdr = findRow(rows, 1, 'Writer')
  if (recHdr >= 0)
    for (const c of takeBlock(rows, recHdr + 1, 1)) {
      recommenders.push({
        writer: text(c[1]),
        subject: text(c[2]) || null,
        year: text(c[3]) || null,
        done: bool(c[4]),
      })
    }

  return { summary, tasks, piqs, schools, ucs, recommenders }
}

// 📆 Meetings: Date | Teacher | Project | Agenda | Homework | HW Status | %
// Only Aaron logs meetings (Ryan doesn't track his), so this is the full record.
export function parseMeetingsGrid(rows) {
  const out = []
  const hdr = findRow(rows, 1, 'Date')
  if (hdr < 0) return out
  for (let i = hdr + 1; i < rows.length; i++) {
    const c = cells(rows[i])
    const rawDate = text(c[1])
    if (!rawDate) break
    const dt = DateTime.fromFormat(rawDate, 'M/d/yyyy', { zone: ZONE })
    out.push({
      date: dt.isValid ? dt.toISODate() : null,
      teacher: text(c[2]) || null,
      project: text(c[3]) || null,
      agenda: text(c[4]) || null,
      homework: text(c[5]) || null,
      hwStatus: text(c[6]).toLowerCase() || null,
      pct: pct(c[7]),
    })
  }
  return out
}

// ── Shared assembly (student + parent college routes) ─────────────────────────

const COLLEGE_TAB = '🏫 College List'
const MEETINGS_TAB = '📆 Meetings'

// Fetch + parse a student's college list (and college-meeting notes) from their
// sheet. Cell-data fetch (not values.get) because the doc links are smart
// chips — only the grid API exposes chipRuns. Returns the payload object, or
// null when the sheet has no college list.
export async function fetchCollegeData(sheets, studentSheetId) {
  const grids = async (ranges) => {
    const res = await sheets.spreadsheets.get({
      spreadsheetId: studentSheetId,
      ranges,
      fields:
        'sheets(properties(title),data(rowData(values(formattedValue,hyperlink,chipRuns))))',
    })
    const byTitle = {}
    for (const s of res.data.sheets || []) {
      byTitle[s.properties?.title] = s.data?.[0]?.rowData || []
    }
    return byTitle
  }

  let byTitle
  try {
    byTitle = await grids([`'${COLLEGE_TAB}'!A1:Q60`, `'${MEETINGS_TAB}'!A1:H400`])
  } catch (e) {
    // A missing Meetings tab would fail the combined request — retry with just
    // the college list before declaring there's no list at all.
    try {
      byTitle = await grids([`'${COLLEGE_TAB}'!A1:Q60`])
    } catch (e2) {
      return null
    }
  }

  const college = parseCollegeGrid(byTitle[COLLEGE_TAB] || [])
  const meetings = parseMeetingsGrid(byTitle[MEETINGS_TAB] || [])
  return { ...college, meetings }
}
