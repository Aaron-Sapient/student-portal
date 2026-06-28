import { DateTime } from 'luxon'
// Relative (NOT the `@/` alias used in lib/scores.js & lib/identity.js): this file
// is dynamic-imported under plain node by scripts/mirrorCollegeLists.cjs, where the
// build-time `@/` jsconfig path does not resolve. Relative specifiers work in both
// the Next.js bundle and node, so the mirror keeps importing this module cleanly.
import { getSupabaseClient, STUDENT_COLLEGE_LISTS } from './supabase.js'
import { readMode, logShadow } from './readFlags.js'

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

// ── Sheets reader (the current, authoritative path) ──────────────────────────
// Fetch + parse a student's college list (and college-meeting notes) from their
// sheet. Cell-data fetch (not values.get) because the doc links are smart
// chips — only the grid API exposes chipRuns. Returns the payload object, or
// null when the sheet has no college list.
//
// EXPORTED (unlike the Sheets readers in scores.js/identity.js, which stay
// internal): the one-way mirror writer scripts/mirrorCollegeLists.cjs must read
// LIVE Sheets regardless of the `colleges` read flag — it's the process that
// POPULATES Supabase, so it can never resolve through the flag-aware dispatcher.
export async function fetchCollegeDataFromSheets(sheets, studentSheetId) {
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

// ── Supabase reader (migration target — table `student_college_lists`) ───────
// The stored `payload` jsonb IS the verbatim object fetchCollegeDataFromSheets
// returns — the mirror upserts exactly that — so reconstruction is identity: read
// the column and return it. No row ⇒ null, the SAME "no college list" signal the
// Sheets path emits (the routes turn it into a 404). THROWS on a query error (not
// return null) so the `on` dispatcher can tell a Supabase blip from a clean miss
// and fall back to Sheets — a false null here would lock a senior out of their
// entire college + essay surface (the 2026-06-19 lockout incident class).
//
// NB: Postgres jsonb does NOT preserve object key insertion order, so the returned
// payload is SEMANTICALLY — not byte — identical to the Sheets path. Every consumer
// (CollegesView, the writing tab-sync) reads by field NAME, so order is irrelevant,
// and the shadow comparator below diffs field-by-field rather than by stringify.
async function fetchCollegeDataFromSupabase(studentSheetId) {
  if (!studentSheetId) return null
  const sb = getSupabaseClient()
  const { data, error } = await sb
    .from(STUDENT_COLLEGE_LISTS)
    .select('payload')
    .eq('student_sheet_id', studentSheetId)
    .maybeSingle()
  if (error) throw new Error(`college list query failed: ${error.message}`)
  return data?.payload ?? null
}

// shadow-mode comparator: returns human-readable diff strings (empty ⇒ match).
// SEMANTIC, never JSON.stringify — jsonb key reordering would false-positive every
// row even when identical. Compares only the surface the college + essay UIs
// actually consume, element-by-element (jsonb ARRAYS preserve order, so positional
// comparison is sound). EXPORTED so scripts/shadowCompareColleges.cjs reuses the
// exact same comparator the live shadow log uses (no drift).
export function diffCollegeData(sheet, supa) {
  const diffs = []
  if (!sheet && !supa) return diffs
  if (!sheet || !supa) {
    diffs.push(`presence sheets=${sheet ? 'y' : 'n'} supa=${supa ? 'y' : 'n'}`)
    return diffs
  }
  for (const k of ['totalProgress', 'privatesPlanned']) {
    const a = sheet.summary?.[k]
    const b = supa.summary?.[k]
    if (String(a) !== String(b)) diffs.push(`summary.${k} ${a}≠${b}`)
  }
  // Compare a parallel array of objects field-by-field on the consumed keys.
  const arr = (name, a, b, keys) => {
    a = a || []
    b = b || []
    if (a.length !== b.length) {
      diffs.push(`${name}.len ${a.length}≠${b.length}`)
      return
    }
    for (let i = 0; i < a.length; i++)
      for (const k of keys)
        if (String(a[i]?.[k]) !== String(b[i]?.[k]))
          diffs.push(`${name}[${i}].${k} ${a[i]?.[k]}≠${b[i]?.[k]}`)
  }
  arr('tasks', sheet.tasks, supa.tasks, ['name', 'pct', 'notes', 'docUrl'])
  arr('piqs', sheet.piqs, supa.piqs, ['prompt', 'chosen', 'pct', 'notes'])
  arr('schools', sheet.schools, supa.schools, [
    'name', 'status', 'major', 'range', 'decision', 'suppUrl', 'pct', 'deadline',
  ])
  arr('ucs', sheet.ucs, supa.ucs, ['name', 'major', 'result'])
  arr('recommenders', sheet.recommenders, supa.recommenders, ['writer', 'subject', 'done'])
  arr('meetings', sheet.meetings, supa.meetings, [
    'date', 'project', 'pct', 'agenda', 'homework', 'hwStatus',
  ])
  return diffs
}

// Fetch a student's college-list payload from Sheets, Supabase, or both per the
// `colleges` read flag (see lib/readFlags.js). Default `off` ⇒ Sheets only —
// today's behavior, byte-for-byte. `shadow` reads both, logs field-level diffs,
// and returns the authoritative Sheets answer. `on` reads Supabase, falling back
// to Sheets ONLY on a Supabase ERROR (identity.js-style, NOT scores.js
// fail-to-null): a clean miss (no mirror row) is authoritative and returns null,
// but a transient failure must degrade to the proven Sheets path rather than
// 404 a senior out of their college + essay surface. Both call sites already
// hold `sheets`, so the signature is unchanged.
export async function fetchCollegeData(sheets, studentSheetId) {
  const mode = readMode('colleges')
  if (mode === 'on') {
    try {
      return await fetchCollegeDataFromSupabase(studentSheetId)
    } catch (e) {
      console.warn(`[colleges:supabase] ${studentSheetId} fell back to Sheets: ${e?.message}`)
      return fetchCollegeDataFromSheets(sheets, studentSheetId)
    }
  }
  if (mode === 'shadow') {
    const [sheetResult, supaResult] = await Promise.all([
      fetchCollegeDataFromSheets(sheets, studentSheetId),
      fetchCollegeDataFromSupabase(studentSheetId).catch((e) => {
        console.warn(`[shadow:colleges] ${studentSheetId} supabase read threw: ${e?.message}`)
        return null
      }),
    ])
    logShadow('colleges', studentSheetId, diffCollegeData(sheetResult, supaResult))
    return sheetResult // shadow ALWAYS returns the authoritative Sheets answer
  }
  return fetchCollegeDataFromSheets(sheets, studentSheetId)
}
