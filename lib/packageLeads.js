// Server-only reader for the growth-funnel lead store (scoreapp_leads in the
// AP-dashboard Supabase project — NOT student-hubs), so the package builder can
// prefill a proposal from a family's SuperScore quiz instead of starting from
// 78 empty cells.
//
// The design frame (Aaron, 2026-08-11 session): the student block in the
// builder is a RECEIVED RECORD WITH PROVENANCE, not a form. Ryan mostly
// shouldn't be typing it — it arrives from the quiz, or it's a manual referral.
// This module supplies the received record; the manual path is just an absent
// one.
//
// Table contract (AP-Counseling/08. Projects/Growth Funnel/superscore-source/
// scoreapp_leads.sql): person-level key is EMAIL, mc_id is attribution never
// identity, `answers` jsonb is the raw truth, every consumer filters
// is_test=eq.false. The table sits behind an anon_all policy on a key that
// already circulates in the AP tooling; the portal still gates access through
// requireAdmin at the route, same as every other developer surface.
//
// Env: AP_FUNNEL_SUPABASE_URL + AP_FUNNEL_SUPABASE_KEY (see .env.local and the
// Vercel prod env). Missing env degrades to "not configured" rather than
// throwing, so the builder renders normally on a machine without funnel access.

import { DateTime } from 'luxon'
import { GRADES } from './pricingSchema'

const ZONE = 'America/Los_Angeles'

const LEAD_COLUMNS =
  'id, created_at, first_name, last_name, email, answers, superscore, pillar_bands, status, src_class, pl'

export function leadsConfigured() {
  return Boolean(process.env.AP_FUNNEL_SUPABASE_URL && process.env.AP_FUNNEL_SUPABASE_KEY)
}

async function leadsFetch(query) {
  const url = process.env.AP_FUNNEL_SUPABASE_URL
  const key = process.env.AP_FUNNEL_SUPABASE_KEY
  if (!url || !key) throw new Error('Funnel Supabase not configured: set AP_FUNNEL_SUPABASE_URL and AP_FUNNEL_SUPABASE_KEY')
  const res = await fetch(`${url.replace(/\/$/, '')}/rest/v1/scoreapp_leads?${query}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`scoreapp_leads read → ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return res.json()
}

// Grade from graduating_year, on the house academic calendar: the school year
// whose graduation is next June. June 1 is the rising-grade flip (same
// convention as the holistic-scores display curve). A May 2026 taker graduating
// 2027 is an 11th grader; the same taker on June 1 is a 12th grader.
export function gradeFromGraduatingYear(graduatingYear, now = DateTime.now().setZone(ZONE)) {
  const gy = Number(graduatingYear)
  if (!Number.isInteger(gy) || gy < 2020 || gy > 2045) return null
  const classYear = now.month >= 6 ? now.year + 1 : now.year
  const grade = 12 - (gy - classYear)
  return grade >= 1 && grade <= 12 ? grade : null
}

// One lead row → the builder-facing prefill record. Every derived field keeps
// its basis alongside it, so the surface can show provenance instead of
// presenting a guess as a fact.
export function leadToPrefill(row) {
  const a = row.answers || {}
  const grade = gradeFromGraduatingYear(a.graduating_year)
  return {
    source: 'superscore',
    leadId: row.id,
    receivedAt: row.created_at,
    status: row.status,
    channel: row.pl || null,
    srcClass: row.src_class || null,
    firstName: row.first_name || '',
    lastName: row.last_name || '',
    email: row.email || '',
    // grade: derived, not asked. builderGrade is null when the derived grade
    // falls outside the builder's 9–11 range (a senior routes to the senior-
    // year package, which this builder doesn't sell) — the caller decides what
    // to do with that, the data layer just refuses to round it into range.
    grade,
    gradeBasis: a.graduating_year ? `graduating_year=${a.graduating_year}` : null,
    builderGrade: grade != null && GRADES.includes(String(grade)) ? String(grade) : null,
    superscore: row.superscore ?? null,
    pillarBands: row.pillar_bands ?? null,
    academics: {
      unweightedGpa: a.unweighted_gpa ?? null,
      apsTaken: a.aps_taken ?? null,
      takenSatOrAct: a.taken_sat_or_act ?? null,
      satPercentile: a.sat_percentile ?? null,
      plansToTakeSatOrAct: a.plans_to_take_sat_or_act ?? null,
    },
    // The narrative answers the /scoreapp rubric weights hardest — the same
    // fields that tell Ryan which tier fits before he's spoken to the family.
    intent: {
      whichBestDescribesYou: a.which_best_describes_you ?? null,
      desired90DayOutcome: a.desired_90_day_outcome ?? null,
      bestSolution: a.best_solution ?? null,
      biggestObstacle: a.biggest_obstacle ?? null,
      anythingElse: a.anything_else ?? null,
    },
  }
}

// Newest-first non-test leads, mapped to prefill records.
export async function listPackageLeads({ limit = 25 } = {}) {
  const rows = await leadsFetch(
    `select=${encodeURIComponent(LEAD_COLUMNS)}&is_test=eq.false&order=created_at.desc&limit=${Math.min(Number(limit) || 25, 100)}`
  )
  return rows.map(leadToPrefill)
}

// One lead by numeric id or by email (newest row wins on email — a family that
// retakes the quiz has multiple rows and the latest answers are the ones Ryan
// is responding to).
//
// Case-sensitivity: `eq.` on a lowercased query is correct because the insert
// path lowercases on write (superscore-source/api/lead.js:122,
// `email: email.toLowerCase()` — verified 2026-08-11). If that route ever
// stops normalizing, this lookup starts missing mixed-case rows.
export async function getPackageLead(idOrEmail) {
  const v = String(idOrEmail || '').trim()
  if (!v) return null
  const filter = /^\d+$/.test(v)
    ? `id=eq.${v}`
    : `email=eq.${encodeURIComponent(v.toLowerCase())}`
  const rows = await leadsFetch(
    `select=${encodeURIComponent(LEAD_COLUMNS)}&is_test=eq.false&${filter}&order=created_at.desc&limit=1`
  )
  return rows.length ? leadToPrefill(rows[0]) : null
}
