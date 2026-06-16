/**
 * scoreStudents.cjs — weekly holistic scoring (Academic / EC / Overall) + the
 * production Claude Coach note. Designed to run as a daily cron on the NAS:
 * each run scores only students whose last score is >6 days old, capped per
 * run, so ~40 students stagger naturally across the week.
 *
 * One `claude -p` (Sonnet, Max-plan auth — NOT the metered API) call per student:
 * the student's sheet tabs are dumped into a packet, scored against the
 * versioned rubric (scoring-rubric.md, beside this file), and the validated
 * JSON is appended to the student's `📊 Scores` tab:
 *   Date | Academic | EC | Overall | Insight | CoachNote | RubricVer | Model
 * The portal reads that tab via lib/scores.js (home rings + coach note).
 *
 * SAFE BY DEFAULT: dry-run (selection + packet stats, no Claude call, no write)
 * and TEST STUDENT only.
 *
 *   node scripts/nas/scoreStudents.cjs                    # dry-run, test student
 *   node scripts/nas/scoreStudents.cjs --commit           # score + write, test student
 *   node scripts/nas/scoreStudents.cjs --commit --force   # …even if scored recently
 *   node scripts/nas/scoreStudents.cjs --commit --all     # GATED: all due students
 *   node scripts/nas/scoreStudents.cjs <SHEET_ID> --commit
 *
 * NAS setup (one-time): .env.local hand-placed at repo root (Syncthing never
 * syncs secrets), `npm ci` run natively (x86_64), `claude` CLI authed to the
 * Max plan. Cron (daily, quiet hours):
 *   10 5 * * * cd /share/.../student-portal && /usr/local/bin/node scripts/nas/scoreStudents.cjs --commit --all >> scripts/nas/logs/score.log 2>&1
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { google } = require('googleapis');
const { hasRecentGrades, TRANSCRIPT_GRADE_RANGE } = require('../../lib/gradeData.js');

const TEST_STUDENT = '1UW-RSqv30c_BUdv9nfm48YVVs7L-UmWKsYn_jXhYt6w'; // Test2 Student2
const SCORES_TAB = '📊 Scores';
const PARAMS_TAB = '⚙️ Score Params'; // Master Sheet, written by the dev dashboard
// Rubric v2 point weights (must mirror lib/scoreParams.js DEFAULT_PARAMS). A
// param row matching its default emits no override — the rubric already says it.
const DEFAULT_PARAMS = {
  'academic.mathPathway': 25,
  'academic.apLoad': 25,
  'academic.gradesVsRigor': 25,
  'academic.satAct': 15,
  'academic.apExams': 10,
  'ec.recognition': 40,
  'ec.awards': 25,
  'ec.selectivePrograms': 15,
  'ec.yearsEngagement': 20,
  'leadership.positions': 40,
  'leadership.inHouse': 30,
  'leadership.sustained': 30,
  'overall.academic': 50,
  'overall.ec': 30,
  'overall.leadership': 20,
};
const PARAM_LABELS = {
  'academic.mathPathway': 'Academic — Math & core-STEM pathway position',
  'academic.apLoad': 'Academic — AP/honors load vs. current year',
  'academic.gradesVsRigor': 'Academic — Grades vs. rigor',
  'academic.satAct': 'Academic — SAT/ACT',
  'academic.apExams': 'Academic — AP exam scores',
  'ec.recognition': 'EC — Level of recognition',
  'ec.awards': 'EC — Awards & results in Comps & Projects',
  'ec.selectivePrograms': 'EC — Selective programs & camps',
  'ec.yearsEngagement': 'EC — Years of engagement',
  'leadership.positions': 'Leadership — Positions held',
  'leadership.inHouse': 'Leadership — In-house project leadership',
  'leadership.sustained': 'Leadership — Sustained commitment to one group',
};
const RUBRIC_VERSION = 'v2.2'; // v2.2: explicit never-negative reframe vocabulary (v2.1: blame-proof rule — notes must never imply the program isn't delivering)
// Sonnet is the production model (decided 6/11): side-by-side evals showed
// Opus took more interpretive liberties — its notes needed MORE manual tweaks
// to avoid parent-upsetting framing, while Sonnet tracked the rubric tighter.
// --model=opus remains available for comparison runs.
const MODEL =
  (process.argv.find((a) => a.startsWith('--model=')) || '').slice('--model='.length) || 'sonnet';
const DUE_AFTER_DAYS = 6; // re-score when the last row is older than this
const MAX_PER_RUN = 8; // cap per cron run → natural weekly stagger
const HEADER = [
  'Date', 'Academic', 'EC', 'Leadership', 'Overall', 'Insight', 'CoachNote', 'RubricVer', 'Model',
];

// Tabs dumped into the packet. College List is senior-only → fetched separately.
// A&H is read twice: the activity/honor text block, and the wide grid where the
// recognition checkboxes (S | S/R | N | I) + grade-level years live (rubric v2).
const CORE_RANGES = [
  "'🎓 Transcript'!A1:N80",
  // Wide + deep: SAT/ACT highest scores live out at cols L/R (~row 51), AP exam
  // scores in col N (~rows 60–75) of the Student Info form.
  "'📃 Student Info'!A1:T120",
  "'⛳ Activities & Honors'!A1:H80",
  "'⛳ Activities & Honors'!A9:AB40",
  // Full depth — long-running students have 100+ rows and the RECENT ones are
  // what the rubric needs; buildPacket trims to the last MEETINGS_KEEP below.
  "'📆 Meetings'!A1:H400",
  "'🏆 Comps & Projects'!B1:M40",
];
const MEETINGS_KEEP = 50; // most recent meeting rows kept in the packet
const SENIOR_RANGE = "'🏫 College List'!A1:Q40";

const args = process.argv.slice(2);
const COMMIT = args.includes('--commit');
const ALL = args.includes('--all');
const FORCE = args.includes('--force');
const SHEET_ARG = args.find((a) => !a.startsWith('--'));
// --as-of=YYYY-MM-DD: score from a historical vantage point — the meeting log
// and previous-score context are filtered to the cutoff, the prompt's "Today"
// becomes the cutoff, and the row is written with that date. Undated tabs
// (transcript, A&H…) can't be rewound; the prompt tells the model to disregard
// content clearly dated after the cutoff.
const AS_OF = (args.find((a) => a.startsWith('--as-of=')) || '').slice('--as-of='.length) || null;
if (AS_OF && !/^\d{4}-\d{2}-\d{2}$/.test(AS_OF)) {
  console.error('Bad --as-of (want YYYY-MM-DD):', AS_OF);
  process.exit(1);
}

function envGet(key) {
  // Repo layout (Mac: scripts/nas/ → root) or flat container layout (/app).
  const candidates = [
    path.join(__dirname, '..', '..', '.env.local'),
    path.join(__dirname, '.env.local'),
  ];
  const file = candidates.find((p) => fs.existsSync(p));
  if (!file) throw new Error('.env.local not found beside script or at repo root');
  const env = fs.readFileSync(file, 'utf8');
  const m = env.match(new RegExp('^' + key + '=(.*)$', 'm'));
  return m ? m[1].replace(/^['"]|['"]$/g, '') : null;
}

// quotaUser re-keys Google's 60 reads/min/user quota per student (verified:
// scripts/testQuotaUser.cjs) — without it a full-roster sweep is 3+ reads × 40
// students in one burst against ONE shared bucket, and the tail 429s.
function getSheets(quotaUser) {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: envGet('GOOGLE_SERVICE_ACCOUNT_EMAIL'),
      private_key: envGet('GOOGLE_PRIVATE_KEY').replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({
    version: 'v4',
    auth,
    ...(quotaUser ? { params: { quotaUser: String(quotaUser).slice(0, 40) } } : {}),
  });
}

// en-CA = YYYY-MM-DD. LA-pinned: toISOString() is UTC and rolls to tomorrow
// after 4/5pm PT, mis-dating evening runs.
const todayISO = () =>
  AS_OF || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

// Parse the sheet's formatted meeting dates ("4/28/23", "7/21/2025") → ISO, or
// null when the cell isn't a date.
function meetingDateISO(raw) {
  const m = String(raw || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  const year = m[3].length === 2 ? `20${m[3]}` : m[3];
  return `${year}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

function daysSince(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? (Date.now() - t) / 86400000 : Infinity;
}

// Master sheet → [{ name, email, sheetId, ryanCheckin, aaronCheckin }]
async function listStudents(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: envGet('MASTER_SHEET_ID'),
    range: "'👩‍🎓 All Data'!A:BD",
  });
  const out = [];
  for (const r of (res.data.values || []).slice(1)) {
    const name = (r[0] || '').trim();
    const email = (r[9] || '').trim();
    const m = (r[6] || '').match(/\/d\/([a-zA-Z0-9-_]+)/);
    if (!name || !m) continue;
    // Class col B = "NC" → not counseling (e.g. Brandon Lee). Never score:
    // their sheets are skeletal and the notes are parent-visible.
    if ((r[1] || '').trim().toUpperCase() === 'NC') continue;
    out.push({
      name,
      email,
      cls: (r[1] || '').trim(),
      sheetId: m[1],
      ryanCheckin: r[50] || null,
      aaronCheckin: r[52] || null,
    });
  }
  return out;
}

// Existing 📊 Scores rows (or null if no tab). Date col A, ISO strings.
async function readScores(sheets, sheetId) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `'${SCORES_TAB}'!A2:I400`,
    });
    return (res.data.values || []).filter((r) => r[0]);
  } catch {
    return null;
  }
}

// Render a values grid as compact pipe-separated lines, skipping empty rows.
function renderTab(title, values, maxChars = 7000) {
  const lines = [];
  (values || []).forEach((row, i) => {
    const cells = (row || []).map((c) => String(c ?? '').trim());
    if (cells.every((c) => !c)) return;
    lines.push(`${i + 1}: ${cells.join(' | ').replace(/\s*\|\s*$/, '')}`);
  });
  let body = lines.join('\n');
  if (body.length > maxChars) body = body.slice(0, maxChars) + '\n…(truncated)';
  return `--- TAB: ${title} ---\n${body || '(empty)'}`;
}

// 📆 Meetings only: drop rows dated after the --as-of cutoff, then keep the
// header + the most recent MEETINGS_KEEP rows (old students have 100+ rows of
// ancient history that would crowd out what the rubric actually reads).
function trimMeetingRows(values) {
  const rows = values || [];
  const header = [];
  const dated = [];
  for (const row of rows) {
    const iso = (row || []).map(meetingDateISO).find(Boolean);
    if (!iso) {
      if (dated.length === 0) header.push(row); // pre-table chrome + header row
      continue;
    }
    if (AS_OF && iso > AS_OF) continue;
    dated.push(row);
  }
  return [...header, ...dated.slice(-MEETINGS_KEEP)];
}

async function buildPacket(sheets, student) {
  // batchGet rejects the WHOLE call if any one range is unparsable (a sheet
  // missing a tab, e.g. no 📆 Meetings). Fall back to per-range gets so one
  // malformed sheet degrades to an explicit "(tab missing)" instead of failing
  // the student on every run forever.
  let valueRanges;
  try {
    const core = await sheets.spreadsheets.values.batchGet({
      spreadsheetId: student.sheetId,
      ranges: CORE_RANGES,
    });
    valueRanges = core.data.valueRanges;
  } catch {
    valueRanges = await Promise.all(
      CORE_RANGES.map(async (range) => {
        try {
          const res = await sheets.spreadsheets.values.get({
            spreadsheetId: student.sheetId,
            range,
          });
          return { range: res.data.range || range, values: res.data.values };
        } catch {
          return { range, values: null, missing: true };
        }
      })
    );
  }
  const parts = valueRanges.map((vr) => {
    const title = vr.range.split('!')[0].replace(/'/g, '');
    if (vr.missing) return `--- TAB: ${title} --- (tab missing from this sheet)`;
    const values = title.includes('Meetings') ? trimMeetingRows(vr.values) : vr.values;
    return renderTab(title, values);
  });
  try {
    const senior = await sheets.spreadsheets.values.get({
      spreadsheetId: student.sheetId,
      range: SENIOR_RANGE,
    });
    parts.push(renderTab('🏫 College List (senior)', senior.data.values));
  } catch {
    parts.push('--- TAB: 🏫 College List --- (none — not a senior sheet)');
  }
  return parts.join('\n\n');
}

// Developer-tuned weights from the Master Sheet's ⚙️ Score Params tab → a
// PARAMETER OVERRIDES block appended after the rubric. Returns '' when the tab
// is absent or everything matches the rubric defaults.
async function readParamOverrides(sheets) {
  let rows;
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: envGet('MASTER_SHEET_ID'),
      range: `'${PARAMS_TAB}'!A2:B100`,
    });
    rows = res.data.values || [];
  } catch {
    return '';
  }
  const overrides = [];
  const weights = {};
  for (const [key, value] of rows) {
    const n = Number(value);
    if (!(key in DEFAULT_PARAMS) || !Number.isFinite(n)) continue;
    if (key.startsWith('overall.')) weights[key] = n;
    if (n !== DEFAULT_PARAMS[key] && PARAM_LABELS[key]) {
      overrides.push(`- ${PARAM_LABELS[key]}: ${n} pts (rubric says ${DEFAULT_PARAMS[key]})`);
    }
  }
  const w = {
    a: weights['overall.academic'] ?? DEFAULT_PARAMS['overall.academic'],
    e: weights['overall.ec'] ?? DEFAULT_PARAMS['overall.ec'],
    l: weights['overall.leadership'] ?? DEFAULT_PARAMS['overall.leadership'],
  };
  const blendChanged =
    w.a !== DEFAULT_PARAMS['overall.academic'] ||
    w.e !== DEFAULT_PARAMS['overall.ec'] ||
    w.l !== DEFAULT_PARAMS['overall.leadership'];
  if (blendChanged) {
    overrides.push(
      `- Overall = round(${(w.a / 100).toFixed(2)} × Academic + ${(w.e / 100).toFixed(2)} × EC + ${(w.l / 100).toFixed(2)} × Leadership) (replaces the rubric's blend)`
    );
  }
  if (!overrides.length) return '';
  return [
    '=== PARAMETER OVERRIDES (developer-tuned) ===',
    'These point values SUPERSEDE the corresponding numbers in the rubric above.',
    'All other rubric instructions are unchanged; factor maximums scale to the new values.',
    ...overrides,
    '',
  ].join('\n');
}

function buildPrompt(rubric, student, packet, prevRows, paramOverrides) {
  const prev =
    prevRows && prevRows.length
      ? prevRows
          .slice(-4)
          .map((r) =>
            // v1 rows (8 cols, no Leadership) vs v2 (9 cols) — detect by RubricVer slot.
            r[6] === 'v1'
              ? `${r[0]}: academic ${r[1]}, ec ${r[2]}, overall ${r[3]} (rubric v1, no leadership) — "${r[4] || ''}"`
              : `${r[0]}: academic ${r[1]}, ec ${r[2]}, leadership ${r[3]}, overall ${r[4]} — "${r[5] || ''}"`
          )
          .join('\n')
      : 'None — this is the first scoring run for this student.';
  // As-of runs: a check-in date after the cutoff hadn't happened yet.
  const checkin = (raw) => {
    if (!raw) return 'unknown';
    if (AS_OF) {
      const iso = meetingDateISO(raw) || String(raw).slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(iso) && iso > AS_OF) return 'unknown';
    }
    return raw;
  };
  return [
    rubric,
    paramOverrides || '',
    AS_OF
      ? `NOTE: You are scoring AS OF ${AS_OF}. The meeting log is filtered to that date. If any other packet content is clearly dated after ${AS_OF}, disregard it.\n`
      : '',
    '=== STUDENT DATA PACKET ===',
    `Student: ${student.name}`,
    `Today: ${todayISO()}`,
    `Last Ryan check-in: ${checkin(student.ryanCheckin)} · Last Aaron check-in: ${checkin(student.aaronCheckin)}`,
    '',
    packet,
    '',
    '=== PREVIOUS SCORES (oldest → newest) ===',
    prev,
    '',
    'Respond with ONLY the JSON object.',
  ].join('\n');
}

// First balanced {...} block in a string (brace scan, string-aware). Falls back
// to the input so JSON.parse still raises a useful error when nothing matches.
function firstJsonObject(text) {
  const start = text.indexOf('{');
  if (start < 0) return text;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return text;
}

// One model call (default Sonnet) via the local claude CLI (Max-plan auth — no API key billing).
function scoreWithClaude(prompt) {
  const raw = execFileSync('claude', ['-p', '--model', MODEL, '--output-format', 'json'], {
    input: prompt,
    encoding: 'utf8',
    timeout: 600000, // NAS CLI calls run 2-4min normally; 5min clipped real runs
    maxBuffer: 10 * 1024 * 1024,
  });
  const outer = JSON.parse(raw);
  const text = (outer.result || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  // The model occasionally appends prose after the JSON — parse just the first
  // balanced object instead of trusting the whole response body.
  const obj = JSON.parse(firstJsonObject(text));
  for (const k of ['academic', 'ec', 'leadership', 'overall']) {
    if (!Number.isInteger(obj[k]) || obj[k] < 0 || obj[k] > 100) {
      throw new Error(`bad ${k}: ${obj[k]}`);
    }
  }
  if (typeof obj.insight !== 'string' || typeof obj.coachNote !== 'string') {
    throw new Error('missing insight/coachNote');
  }
  return obj;
}

async function ensureScoresTab(sheets, sheetId) {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: sheetId,
    fields: 'sheets(properties(title))',
  });
  const titles = meta.data.sheets.map((s) => s.properties.title);
  if (titles.includes(SCORES_TAB)) return;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      requests: [
        {
          addSheet: {
            properties: { title: SCORES_TAB, hidden: true, gridProperties: { rowCount: 400, columnCount: 9 } },
          },
        },
      ],
    },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `'${SCORES_TAB}'!A1:I1`,
    valueInputOption: 'RAW',
    requestBody: { values: [HEADER] },
  });
  console.log('  created 📊 Scores tab (hidden)');
}

async function scoreStudent(sheets, rubric, student, paramOverrides) {
  // Data-sufficiency gate: a student with no recorded grades for the current or
  // previous semester (1-month grace at term start) genuinely can't be scored.
  // Their portal dashboard grays out (lib/gradeData + home-data) — so don't
  // manufacture a number here. Existing rows are left untouched; the display
  // re-checks independently and stays gray until grades land. By-sheet-id test
  // runs have no class → the gate no-ops (academicGrade → null → enough).
  const [ty, tm] = todayISO().split('-').map(Number);
  let transcript = [];
  try {
    const tr = await sheets.spreadsheets.values.get({
      spreadsheetId: student.sheetId,
      range: TRANSCRIPT_GRADE_RANGE,
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    transcript = tr.data.values || [];
  } catch {
    transcript = [];
  }
  const gate = hasRecentGrades(transcript, student.cls, { year: ty, month: tm });
  if (!gate.enough) {
    console.log(`  skip (insufficient grade data — ${gate.reason}; grade ${gate.grade}) — dashboard grays out`);
    return false;
  }

  let prevRows = await readScores(sheets, student.sheetId);
  // As-of runs only know about score rows that existed by the cutoff.
  if (AS_OF && prevRows) prevRows = prevRows.filter((r) => String(r[0]) <= AS_OF);
  const lastDate = prevRows?.length ? prevRows[prevRows.length - 1][0] : null;
  if (!FORCE && lastDate && daysSince(lastDate) < DUE_AFTER_DAYS) {
    console.log(`  skip (scored ${lastDate})`);
    return false;
  }

  const packet = await buildPacket(sheets, student);
  // Minimum-viable-packet guard: a transient Sheets outage can make EVERY
  // range fall back to "(tab missing)" (seen live 6/11 — Veda's reads flaked
  // and Sonnet dutifully scored a neutral 50/50/50/50 on a 426-char packet;
  // only the write also failing kept garbage off her sheet). Scoring an empty
  // packet is never right — throw and let the next run retry instead.
  const missingTabs = (packet.match(/\(tab missing from this sheet\)/g) || []).length;
  if (packet.length < 2000 || missingTabs >= 4) {
    throw new Error(
      `packet too thin (${packet.length} chars, ${missingTabs}/${CORE_RANGES.length} tabs unreadable) — sheet empty or reads flaking`
    );
  }
  const prompt = buildPrompt(rubric, student, packet, prevRows, paramOverrides);
  console.log(`  packet ${packet.length} chars · prev rows ${prevRows?.length || 0}`);

  if (!COMMIT) {
    console.log('  dry-run: skipping Claude call + write');
    return false;
  }

  const t0 = Date.now();
  const s = scoreWithClaude(prompt);
  console.log(
    `  ${MODEL} ${(Date.now() - t0) / 1000 | 0}s → academic ${s.academic} · ec ${s.ec} · leadership ${s.leadership} · overall ${s.overall}`
  );
  console.log(`  insight: ${s.insight}`);
  console.log(`  coach:   ${s.coachNote}`);

  await ensureScoresTab(sheets, student.sheetId);
  await sheets.spreadsheets.values.append({
    spreadsheetId: student.sheetId,
    range: `'${SCORES_TAB}'!A:I`,
    valueInputOption: 'RAW',
    requestBody: {
      values: [
        [
          todayISO(),
          s.academic,
          s.ec,
          s.leadership,
          s.overall,
          s.insight,
          s.coachNote,
          RUBRIC_VERSION,
          MODEL,
        ],
      ],
    },
  });
  console.log('  ✓ appended');
  return true;
}

async function main() {
  const sheets = getSheets();
  const rubric = fs.readFileSync(path.join(__dirname, 'scoring-rubric.md'), 'utf8');
  console.log(`[${new Date().toISOString()}] ${COMMIT ? 'COMMIT' : 'DRY-RUN'}${ALL ? ' --all' : ''}${AS_OF ? ` --as-of=${AS_OF}` : ''}`);

  const paramOverrides = await readParamOverrides(sheets);
  if (paramOverrides) console.log('Param overrides active:\n' + paramOverrides);

  let targets;
  if (ALL) {
    targets = await listStudents(sheets);
  } else {
    const id = SHEET_ARG || TEST_STUDENT;
    const all = await listStudents(sheets);
    targets = [all.find((s) => s.sheetId === id) || { name: '(by sheet id)', sheetId: id }];
  }

  let done = 0;
  for (const student of targets) {
    if (done >= MAX_PER_RUN) {
      console.log(`Cap of ${MAX_PER_RUN} reached — the rest stagger to later runs.`);
      break;
    }
    console.log(`Scoring: ${student.name} (${student.sheetId.slice(0, 8)}…)`);
    try {
      // Per-student client → per-student read-quota bucket.
      const studentSheets = getSheets(student.sheetId);
      if (await scoreStudent(studentSheets, rubric, student, paramOverrides)) done++;
    } catch (e) {
      console.error(`  ✗ FAILED: ${e.message} — will retry next run`);
    }
  }
  console.log(`Done — ${done} student(s) scored.`);
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
