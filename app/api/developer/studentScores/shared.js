import { google } from 'googleapis';
import { DateTime } from 'luxon';

// Helpers shared by the studentScores routes (the roster list and the
// per-student [sheetId] detail). Not a route file — only HTTP-method exports
// are allowed in route.js, so the common pieces live here.

export const MASTER_TAB = "'👩‍🎓 All Data'";
export const SCORES_TAB = '📊 Scores';

const ZONE = 'America/Los_Angeles';

// Master-roster rows: name (A), grade (B), portal-sheet URL (G). Every write
// path validates the incoming sheetId against this list — the id itself
// carries no authority.
export async function listRoster(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.MASTER_SHEET_ID,
    range: `${MASTER_TAB}!A:G`,
  });
  const roster = [];
  for (const r of (res.data.values || []).slice(1)) {
    const name = String(r?.[0] ?? '').trim();
    const m = String(r?.[6] ?? '').match(/\/d\/([a-zA-Z0-9-_]+)/);
    if (!name || !m) continue;
    roster.push({ name, grade: String(r?.[1] ?? '').trim(), sheetId: m[1] });
  }
  return roster;
}

// The roster fan-out costs 1 + N Sheets reads (each student is a separate
// spreadsheet, so batchGet can't help) against a 60 reads/min quota shared by
// every service-account call in the app — two uncached loads in a minute blow
// it. Scores only change weekly (NAS cron) plus the occasional manual edit
// here, so the assembled payload is cached in-process and invalidated on
// writes. Lives on globalThis because route.js and [sheetId]/route.js compile
// as separate bundles whose module scopes don't share state.
const SCORES_CACHE_MS = 10 * 60 * 1000;
const scoresCache = (globalThis.__devScoresCache ??= { at: 0, payload: null });

export function getCachedScores({ allowExpired = false } = {}) {
  if (!scoresCache.payload) return null;
  if (!allowExpired && Date.now() - scoresCache.at > SCORES_CACHE_MS) return null;
  return scoresCache.payload;
}

export function setCachedScores(payload) {
  scoresCache.at = Date.now();
  scoresCache.payload = payload;
}

export function clearCachedScores() {
  scoresCache.at = 0;
  scoresCache.payload = null;
}

// Write-scoped client (lib/google's shared client is sheets read-only).
export function getWriteSheets() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

// UNFORMATTED_VALUE cell → ISO date or null. Handles Sheets serial numbers and
// ISO / JS-parseable timestamp strings (mirrors checkinCompliance's parser).
export function cellToISODate(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') {
    if (!raw) return null;
    const dt = DateTime.fromMillis(Math.round((raw - 25569) * 86400 * 1000)).setZone(ZONE);
    return dt.isValid ? dt.toISODate() : null;
  }
  const s = String(raw).trim();
  if (!s || /^n\/?a$/i.test(s) || /^tbd$/i.test(s) || s === '-') return null;
  let dt = DateTime.fromISO(s, { zone: ZONE });
  if (!dt.isValid) {
    const js = new Date(s);
    if (!isNaN(js.getTime())) dt = DateTime.fromJSDate(js).setZone(ZONE);
  }
  return dt.isValid ? dt.toISODate() : null;
}
