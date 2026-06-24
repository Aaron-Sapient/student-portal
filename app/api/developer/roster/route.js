import { DateTime } from 'luxon';
import { requireAdmin } from '@/lib/developerAuth';
import { getGoogleSheetsClient } from '@/lib/google';
import { getSupabaseClient, STUDENT_PROFILES } from '@/lib/supabase';
import { listRoster, readLatestCheckins, normName } from '../studentScores/shared';

const ZONE = 'America/Los_Angeles';

// GET /api/developer/roster → the full student roster
// ({ sheetId, name, grade, classYear, major }) for the Students-tab cards and
// the Writing tab's fuzzy picker. Unlike /api/developer/studentScores this
// includes EVERY student, not just the ones with a 📊 Scores tab. Admin-gated
// (so it works on the Ryan-facing /dev surface too). One Master Sheet read for
// name/class/sheetId + one Supabase read for the intended major (joined from the
// student_profiles mirror; degrades to null if the mirror isn't populated yet).
// Cached in-process since the roster changes rarely and the Master read counts
// against the shared Sheets quota. Lives on globalThis so the bundle's module
// scope survives reloads.
const ROSTER_CACHE_MS = 10 * 60 * 1000;
const rosterCache = (globalThis.__devRosterCache ??= { at: 0, students: null });

// Intended major per sheetId from the student_profiles mirror. One query, all
// rows. Never throws — a missing table / empty mirror just yields no majors, so
// cards show "—" until the reconcile cron backfills (graceful degradation).
async function majorsBySheetId() {
  try {
    const sb = getSupabaseClient();
    const { data, error } = await sb
      .from(STUDENT_PROFILES)
      .select('student_sheet_id, major');
    if (error) return {};
    const out = {};
    for (const r of data || []) {
      const m = String(r.major ?? '').trim();
      if (m) out[r.student_sheet_id] = m;
    }
    return out;
  } catch {
    return {};
  }
}

export async function GET() {
  const gate = await requireAdmin();
  if (!gate.ok) return gate.response;

  if (rosterCache.students && Date.now() - rosterCache.at < ROSTER_CACHE_MS) {
    return Response.json({ students: rosterCache.students });
  }

  try {
    const sheets = getGoogleSheetsClient('developer-dashboard');
    const [roster, majors, checkins] = await Promise.all([
      listRoster(sheets),
      majorsBySheetId(),
      // Check-in recency feeds the Students-tab compliance pill. Degrades to an
      // empty map (cards show "No check-ins") if the form tabs can't be read.
      readLatestCheckins(sheets).catch(() => new Map()),
    ]);
    const nowLA = DateTime.now().setZone(ZONE);
    const students = roster.map((s) => {
      const lastCheckin = checkins.get(normName(s.name)) || null;
      let daysSinceCheckin = null;
      if (lastCheckin) {
        const d = DateTime.fromISO(lastCheckin, { zone: ZONE });
        if (d.isValid) daysSinceCheckin = Math.floor(nowLA.diff(d, 'days').days);
      }
      return {
        sheetId: s.sheetId,
        name: s.name,
        grade: s.grade,
        classYear: s.classYear,
        major: majors[s.sheetId] || null,
        lastCheckin,
        daysSinceCheckin,
      };
    });
    rosterCache.at = Date.now();
    rosterCache.students = students;
    return Response.json({ students });
  } catch (err) {
    console.error('roster GET error:', err);
    if (rosterCache.students) return Response.json({ students: rosterCache.students });
    return Response.json({ error: err.message || 'Server error' }, { status: 500 });
  }
}
