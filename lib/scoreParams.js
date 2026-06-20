// Developer-tunable scoring parameters (rubric v2 point weights). Stored as
// key|value rows in a hidden `⚙️ Score Params` tab on the Master Sheet so both
// the portal (this lib) and the NAS scorer (scripts/nas/scoreStudents.cjs,
// which re-implements the read in CJS) see the same values. Defaults mirror
// scripts/nas/scoring-rubric.md — an absent tab or row means "use the rubric
// as written".

import { getSupabaseClient } from '@/lib/supabase'
import { readMode, logShadow } from '@/lib/readFlags'

export const SCORE_PARAMS_TAB = '⚙️ Score Params'

// Grouped for the dashboard UI; flat keys for storage. Each group's values
// must sum to `total` so the rubric's arithmetic stays coherent.
export const PARAM_GROUPS = [
  {
    key: 'academic',
    label: 'Academic',
    total: 100,
    params: [
      { key: 'academic.mathPathway', label: 'Math & core-STEM pathway', dflt: 25 },
      { key: 'academic.apLoad', label: 'AP/honors load vs. year', dflt: 25 },
      { key: 'academic.gradesVsRigor', label: 'Grades vs. rigor', dflt: 25 },
      { key: 'academic.satAct', label: 'SAT/ACT', dflt: 15 },
      { key: 'academic.apExams', label: 'AP exam scores', dflt: 10 },
    ],
  },
  {
    key: 'ec',
    label: 'Extracurricular',
    total: 100,
    params: [
      { key: 'ec.recognition', label: 'Level of recognition', dflt: 40 },
      { key: 'ec.awards', label: 'Awards & results (C&P)', dflt: 25 },
      { key: 'ec.selectivePrograms', label: 'Selective programs & camps', dflt: 15 },
      { key: 'ec.yearsEngagement', label: 'Years of engagement', dflt: 20 },
    ],
  },
  {
    key: 'leadership',
    label: 'Leadership',
    total: 100,
    params: [
      { key: 'leadership.positions', label: 'Positions held', dflt: 40 },
      { key: 'leadership.inHouse', label: 'In-house project leadership', dflt: 30 },
      { key: 'leadership.sustained', label: 'Sustained commitment', dflt: 30 },
    ],
  },
  {
    key: 'overall',
    label: 'Overall blend (%)',
    total: 100,
    params: [
      { key: 'overall.academic', label: 'Academic weight', dflt: 50 },
      { key: 'overall.ec', label: 'Extracurricular weight', dflt: 30 },
      { key: 'overall.leadership', label: 'Leadership weight', dflt: 20 },
    ],
  },
]

export const DEFAULT_PARAMS = Object.fromEntries(
  PARAM_GROUPS.flatMap((g) => g.params.map((p) => [p.key, p.dflt]))
)

// Merge raw [key, value] pairs over the defaults. Shared by both readers so the
// Sheets and Supabase paths produce an identical params object.
function mergeParams(pairs) {
  const params = { ...DEFAULT_PARAMS }
  for (const [key, value] of pairs) {
    const n = Number(value)
    if (key in params && Number.isFinite(n)) params[key] = n
  }
  return params
}

async function readScoreParamsFromSheets(sheets) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.MASTER_SHEET_ID,
      range: `'${SCORE_PARAMS_TAB}'!A2:B100`,
    })
    return mergeParams(res.data.values || [])
  } catch {
    return { ...DEFAULT_PARAMS } // tab not created yet → defaults
  }
}

// Supabase target: table `score_params` (param_key PK, weight). Global config,
// not per-student.
async function readScoreParamsFromSupabase() {
  const sb = getSupabaseClient()
  const { data, error } = await sb.from('score_params').select('param_key, weight')
  if (error) {
    console.warn(`[score_params:supabase] query failed: ${error.message}`)
    return { ...DEFAULT_PARAMS }
  }
  return mergeParams((data || []).map((r) => [r.param_key, r.weight]))
}

function diffParams(a, b) {
  const diffs = []
  for (const k of Object.keys(DEFAULT_PARAMS)) {
    if (String(a[k]) !== String(b[k])) diffs.push(`${k} ${a[k]}≠${b[k]}`)
  }
  return diffs
}

// { params } merged over defaults; tab missing → pure defaults. Reads from
// Sheets, Supabase, or both per the `score_params` read flag (lib/readFlags.js).
// Default `off` ⇒ Sheets, unchanged.
export async function readScoreParams(sheets) {
  const mode = readMode('score_params')
  if (mode === 'on') return readScoreParamsFromSupabase()
  if (mode === 'shadow') {
    const [sheetParams, supaParams] = await Promise.all([
      readScoreParamsFromSheets(sheets),
      readScoreParamsFromSupabase().catch((e) => {
        console.warn(`[shadow:score_params] supabase read threw: ${e?.message}`)
        return null
      }),
    ])
    logShadow(
      'score_params',
      'weights',
      supaParams ? diffParams(sheetParams, supaParams) : ['supabase read failed']
    )
    return sheetParams // shadow ALWAYS returns the authoritative Sheets answer
  }
  return readScoreParamsFromSheets(sheets)
}

// Validate a full candidate set: every known key present, integer 0–100, and
// each group summing to its total. Returns an error string or null.
export function validateScoreParams(candidate) {
  for (const group of PARAM_GROUPS) {
    let sum = 0
    for (const p of group.params) {
      const v = candidate?.[p.key]
      if (!Number.isInteger(v) || v < 0 || v > 100) {
        return `${p.label}: must be a whole number between 0 and 100`
      }
      sum += v
    }
    if (sum !== group.total) {
      return `${group.label} weights must total ${group.total} (currently ${sum})`
    }
  }
  return null
}

async function ensureParamsTab(sheets) {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: process.env.MASTER_SHEET_ID,
    fields: 'sheets(properties(title))',
  })
  const titles = (meta.data.sheets || []).map((s) => s.properties.title)
  if (titles.includes(SCORE_PARAMS_TAB)) return
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: process.env.MASTER_SHEET_ID,
    requestBody: {
      requests: [
        {
          addSheet: {
            properties: {
              title: SCORE_PARAMS_TAB,
              hidden: true,
              gridProperties: { rowCount: 100, columnCount: 3 },
            },
          },
        },
      ],
    },
  })
}

// Overwrite the tab with the full validated set (one key|value|label row per
// param). Caller must have run validateScoreParams first.
export async function writeScoreParams(sheets, params) {
  await ensureParamsTab(sheets)
  const rows = PARAM_GROUPS.flatMap((g) =>
    g.params.map((p) => [p.key, params[p.key], p.label])
  )
  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.MASTER_SHEET_ID,
    range: `'${SCORE_PARAMS_TAB}'!A1:C${rows.length + 1}`,
    valueInputOption: 'RAW',
    requestBody: { values: [['Key', 'Value', 'Label'], ...rows] },
  })
}
