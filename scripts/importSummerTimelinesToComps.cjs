#!/usr/bin/env node
// Import summer timelines (Supabase `summer_timelines`, the AP Dashboard's
// interpretation of each student's *_EXTERNAL.html) into the student sheets'
// 🏆 Comps & Projects tabs, one row PER PHASE (Olivia-style "X P1: Phase"),
// then write each timeline row's `linked_activity` back to the matching
// Comps col-E concat so the summer audit's milestone signal can find the %.
//
// Dry-run by default — prints every proposed write. `--write` executes.
// Source of record is the Supabase table, NOT the HTML files (those are
// already hash-gate imported by the NAS compliance job).
//
// College List rows (`linked_activity` starting "College List: ") are skipped:
// the audit reads the 🏫 College List tab for those directly.

const fs = require('fs');
const path = require('path');

for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
}
const { google } = require('googleapis');

const WRITE = process.argv.includes('--write');
const SB_URL = 'https://udwuvhacmutpfejfjmlh.supabase.co/rest/v1';
const SB_KEY = (() => {
  const txt = fs.readFileSync(
    `${process.env.HOME}/.claude/secrets/supabase-admissions-partners/ap-dashboard.txt`, 'utf8');
  return txt.match(/Publishable Key:\s*(\S+)/)[1];
})();

// ---------------------------------------------------------------------------
// The mapping, authored 2026-06-12 from the live summer_timelines rows + each
// sheet's existing Comps rows. `match` finds an existing row by col-C item
// (trimmed); `set` lists cell values to fill (letters = real sheet columns).
// `link` = summer_timelines ids whose linked_activity should point at the row.
// Dates are M/D/YYYY strings (USER_ENTERED). Status: 🟢 if phase starts within
// ~3 days or is underway, 🟡 if the phase is still ahead (Olivia convention).
// ---------------------------------------------------------------------------
const PLAN = {
  'Isaac Lee': {
    updates: [
      // Row 69, the one that started this: becomes the Build phase.
      { match: 'Pandemic Project',
        set: { C: 'Pandemic Project P1: Build', G: '7/31/2026', H: '7/31/2026' }, link: [32] },
      // Global Health Initiative == the PAHO/WHO flagship placement row. Window
      // TBC (Ryan arranging) so no dates; stays 🟡.
      { match: 'PAHO', set: {}, link: [31] },
    ],
    appends: [
      { B: '✔️ Projects', C: 'Pandemic Project P2: Publish', D: 2026,
        F: '8/1/2026', G: '8/28/2026', H: '8/28/2026', K: '🟡', link: [33] },
      { B: '✔️ Projects', C: 'Volunteer Network P1: Onboarding', D: 2026,
        F: '6/1/2026', G: '6/19/2026', H: '6/19/2026', K: '🟢', link: [34] },
      { B: '✔️ Projects', C: 'Volunteer Network P2: Anchor Shifts', D: 2026,
        F: '6/22/2026', G: '8/28/2026', H: '8/28/2026', K: '🟡', link: [35, 36] },
      { B: '✔️ Projects', C: 'Volunteer Network P3: Civic Rotation', D: 2026,
        F: '7/6/2026', G: '9/7/2026', H: '9/7/2026', K: '🟡', link: [37] },
      { B: '✔️ Projects', C: 'Public-Health Capstone P1: Draft', D: 2026,
        F: '7/13/2026', G: '8/15/2026', H: '8/15/2026', K: '🟡',
        L: 'phase split approximated from timeline', link: [38] },
      { B: '✔️ Projects', C: 'Public-Health Capstone P2: Submit', D: 2026,
        F: '8/16/2026', G: '8/28/2026', H: '8/28/2026', K: '🟡', link: [39] },
    ],
  },

  'Doudou Shen': {
    updates: [],
    appends: [
      // mid/complete pairs on one name = checkpoints of a single phase row
      { B: 'Academics', C: 'In-House SAT Program', D: "'26",
        F: '6/22/2026', G: '8/8/2026', H: '8/8/2026', K: '🟡', link: [52, 53] },
      { B: 'Projects', C: 'Library of Congress Interviews', D: "'26",
        F: '6/1/2026', G: '8/28/2026', H: '8/28/2026', K: '🟢', link: [54, 55] },
      { B: 'Projects', C: 'Capstone Essay P1: Draft', D: "'26",
        F: '7/1/2026', G: '8/1/2026', H: '8/1/2026', K: '🟡',
        L: 'phase split approximated from timeline', link: [56] },
      { B: 'Projects', C: 'Capstone Essay P2: Final', D: "'26",
        F: '8/2/2026', G: '8/8/2026', H: '8/8/2026', K: '🟡', link: [57] },
    ],
  },

  'Kirthi Reddy': {
    updates: [],
    appends: [
      { B: 'Camps', C: 'ROP Biomedical Internship', D: "'26",
        F: '6/8/2026', G: '7/29/2026', H: '7/29/2026', K: '🟢', link: [58, 59] },
      { B: 'Admissions', C: 'SAT HYPER', D: "'26",
        F: '6/15/2026', G: '8/1/2026', H: '8/1/2026', K: '🟢', link: [60] },
      { B: 'Academics', C: 'AP Bio + AP Chem Self-Study', D: "'26",
        F: '6/15/2026', G: '8/28/2026', H: '8/28/2026', K: '🟢', link: [61] },
      // [62] elective deepener left unlinked on purpose: choice of three still
      // open (existing placeholder rows CNA program / UCI lab partners remain).
    ],
  },

  'Sahasra Mallidi': {
    updates: [],
    appends: [
      { B: 'Projects', C: 'Research Paper 1 P1: Draft', D: "'26",
        F: '6/15/2026', G: '7/15/2026', H: '7/15/2026', K: '🟢',
        L: 'phase split approximated from timeline', link: [63] },
      { B: 'Projects', C: 'Research Paper 1 P2: Submit', D: "'26",
        F: '7/16/2026', G: '7/31/2026', H: '7/31/2026', K: '🟡', link: [64] },
      { B: 'Projects', C: 'Brazil Research Leg (Itaipu + Iguacu)', D: "'26",
        F: '7/1/2026', G: '7/31/2026', H: '7/31/2026', K: '🟡', link: [65] },
      { B: 'Projects', C: 'Research Paper 2 P1: Draft', D: "'26",
        F: '8/1/2026', G: '8/28/2026', H: '8/28/2026', K: '🟡',
        L: 'phase split approximated from timeline', link: [66] },
      { B: 'Projects', C: 'Research Paper 2 P2: Submit', D: "'26",
        F: '8/29/2026', G: '9/7/2026', H: '9/7/2026', K: '🟡', link: [67] },
      { B: 'Projects', C: 'Research Portfolio + Photo-Essay', D: "'26",
        F: '7/1/2026', G: '9/7/2026', H: '9/7/2026', K: '🟡', link: [68] },
      // [69] stretch paper 3: decision due end of July — intentionally no row.
      { B: 'Competitions', C: 'Stockholm Junior Water Prize', D: "'27",
        F: '7/1/2026', G: '4/15/2027', H: '4/15/2027', K: '🟡', link: [70] },
    ],
  },

  'Shriya Lingineni': {
    updates: [
      // The epidemic-intelligence initiative == the existing "Public Policy"
      // row (judgment call — flag if wrong). Fill its empty dates.
      { match: 'Public Policy',
        set: { F: '6/1/2026', G: '8/28/2026', H: '8/28/2026' }, link: [71, 72] },
      // ART 2 rotation: dates provisional in timeline; sheet already has
      // explicit dates — link only, change nothing.
      { match: 'ART 2', set: {}, link: [73] },
      // SAT Hyper: row exists with exact Jun 15 – Aug 1 dates; linked_activity
      // currently 'SAT' (inexact) — re-point at the exact concat.
      { match: 'SAT', set: {}, link: [74] },
    ],
    appends: [],
  },

  'Srikar Kesanam': {
    updates: [
      // [75]/[76] already linked to 'Polygence '26' (curve-on-one-row). Left
      // as-is — see open question in the run summary.
    ],
    appends: [
      { B: 'Camps', C: 'Summer at UCLA (Outset)', D: "'26",
        F: '7/1/2026', G: '7/31/2026', H: '7/31/2026', K: '🟡',
        L: 'one-week residential, exact July week TBC', link: [77] },
      { B: 'Academics', C: 'HarvardX Neuroscience Certificate', D: "'26",
        F: '6/15/2026', G: '8/28/2026', H: '8/28/2026', K: '🟢', link: [78] },
      { B: 'Projects', C: 'Weekly Clinical Hours', D: "'26",
        F: '6/1/2026', G: '8/28/2026', H: '8/28/2026', K: '🟢',
        L: 'Hoag Jr Auxiliary or Lestonnac — venue TBC', link: [79] },
      { B: 'Projects', C: 'Irvine Senior Services', D: "'26",
        F: '6/1/2026', G: '8/28/2026', H: '8/28/2026', K: '🟢', link: [80] },
    ],
  },

  'Vaibhav Gaddam': {
    // Was curve-on-one-row; Aaron 2026-06-12: split into phase rows.
    updates: [
      { match: 'OMNI - Spinoff',
        set: { C: 'OMNI - Spinoff P1: Scoping', G: '6/19/2026', H: '6/19/2026', K: '🟢' }, link: [19] },
    ],
    appends: [
      { B: 'Projects', C: 'OMNI - Spinoff P2: Platform Build', D: "'26",
        F: '6/20/2026', G: '7/31/2026', H: '7/31/2026', K: '🟡',
        L: 'drone platform built & validated, working form by Jul 31', link: [20] },
      { B: 'Projects', C: 'OMNI - Spinoff P3: Write-up & Archive', D: "'26",
        F: '8/1/2026', G: '8/28/2026', H: '8/28/2026', K: '🟡',
        L: 'investigation written up & archived under OMNI', link: [21] },
    ],
  },

  // Olivia Lee: fully linked already — no actions.
  // Srikar's Polygence [75]/[76] stays curve-on-one-row per Aaron 2026-06-12.
  // Aariv Bhalla: timeline is a name-only scope stub (id 6) — nothing to import.
};

const TAB = "'\u{1F3C6} Comps & Projects'";
const COLS = 'BCDEFGHIJKLM'; // written range per row
const colIdx = (l) => l.charCodeAt(0) - 66; // B=0 … M=11 within B:M reads

function predictConcat(formulaTemplate, C, D) {
  const c = String(C ?? '').trim(), d = String(D ?? '').trim();
  if (/TEXTJOIN/i.test(formulaTemplate || '')) return [c, d].filter(Boolean).join(' ');
  return `${c} ${d}`.trimEnd() + (d ? '' : ''); // C&" "&D keeps trailing space when D empty
}

(async () => {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  // roster: name → student sheet id
  const master = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.MASTER_SHEET_ID,
    range: "'\u{1F469}‍\u{1F393} All Data'!A:G",
  });
  const sheetIds = {};
  for (const row of master.data.values || []) {
    const m = (row[6] || '').match(/\/d\/([a-zA-Z0-9-_]+)/);
    if ((row[0] || '').trim() && m) sheetIds[(row[0] || '').trim()] = m[1];
  }

  const sbPatches = []; // { id, linked_activity } resolved as we go

  for (const [student, plan] of Object.entries(PLAN)) {
    const sid = sheetIds[student];
    console.log(`\n=== ${student} (${sid || 'NO SHEET ID'}) ===`);
    if (!sid) continue;

    const [valRes, formRes] = await Promise.all([
      sheets.spreadsheets.values.get({
        spreadsheetId: sid, range: `${TAB}!B1:M200`, valueRenderOption: 'UNFORMATTED_VALUE',
      }),
      sheets.spreadsheets.values.get({
        spreadsheetId: sid, range: `${TAB}!B1:M200`, valueRenderOption: 'FORMULA',
      }),
    ]);
    const vals = valRes.data.values || [];
    const forms = formRes.data.values || [];

    // header row = the one whose C cell is Activity/Item
    const headerIdx = vals.findIndex((r) => ['Activity', 'Item'].includes(String(r?.[1] || '').trim()));
    if (headerIdx < 0) { console.log('  !! no header row found — skipping'); continue; }

    // template formulas for E (concat) and J (bar) from any data row that has them
    let eTpl = '', jTpl = '';
    for (let i = headerIdx + 1; i < forms.length; i++) {
      const e = String(forms[i]?.[3] || ''), j = String(forms[i]?.[8] || '');
      if (!eTpl && e.startsWith('=')) eTpl = e;
      if (!jTpl && j.startsWith('=')) jTpl = j;
      if (eTpl && jTpl) break;
    }
    const renumber = (tpl, rowNum) => tpl.replace(/([A-Z]{1,2})\d+/g, `$1${rowNum}`);

    const findRow = (item) => {
      for (let i = headerIdx + 1; i < vals.length; i++)
        if (String(vals[i]?.[1] ?? '').trim() === item) return i; // 0-based
      return -1;
    };

    const data = [];

    for (const u of plan.updates || []) {
      const i = findRow(u.match);
      if (i < 0) { console.log(`  !! UPDATE target not found: "${u.match}" — skipping`); continue; }
      const rowNum = i + 1;
      const sets = Object.entries(u.set || {});
      for (const [col, val] of sets)
        data.push({ range: `${TAB}!${col}${rowNum}`, values: [[val]] });
      const newC = u.set?.C ?? vals[i][1];
      const newD = u.set?.D ?? vals[i][2];
      const concat = eTpl ? predictConcat(eTpl, newC, newD) : String(vals[i][3] ?? '').trimEnd();
      // when nothing changes, link against the CURRENT concat value verbatim
      const linkVal = sets.length ? concat : String(vals[i][3] ?? '');
      console.log(`  UPDATE r${rowNum} "${u.match}"` +
        (sets.length ? ` set ${sets.map(([c, v]) => `${c}=${v}`).join(', ')}` : ' (link only)') +
        ` → link [${u.link.join(',')}] = '${linkVal}'`);
      for (const id of u.link || []) sbPatches.push({ id, linked_activity: linkVal, sheetId: sid, rowNum });
    }

    // First free row after the last real data row. Sheets keep ~20 template
    // rows below the table (E/J formulas + I=0 prefilled) — those count as
    // empty, so new rows land INSIDE the template block, not below it.
    const isData = (r) =>
      (r || []).some((c, j) => ![3, 7, 8].includes(j) && String(c ?? '').trim() !== '');
    let lastData = headerIdx;
    for (let i = headerIdx + 1; i < vals.length; i++) if (isData(vals[i])) lastData = i;
    let nextRow = lastData + 2; // 1-based row number of first free row

    for (const a of plan.appends || []) {
      if (findRow(a.C) >= 0) { console.log(`  == APPEND skipped, already exists: "${a.C}"`); continue; }
      const rowNum = nextRow++;
      const row = new Array(12).fill('');
      for (const col of ['B', 'C', 'F', 'G', 'H', 'K', 'L']) if (a[col] !== undefined) row[colIdx(col)] = a[col];
      // D: years like '26 need a doubled apostrophe under USER_ENTERED to keep the quote char
      if (a.D !== undefined) row[colIdx('D')] = typeof a.D === 'string' && a.D.startsWith("'") ? `'${a.D}` : a.D;
      if (eTpl) row[colIdx('E')] = renumber(eTpl, rowNum);
      if (jTpl) row[colIdx('J')] = renumber(jTpl, rowNum);
      // '0%' (not 0): forces percent format on the cell. Template/blank-region
      // cells can carry date formatting, under which the col-J bar formula
      // reads 0 as "12/30/99" and VALUE() parses that as a date serial —
      // producing a multi-thousand-pipe bar.
      row[colIdx('I')] = '0%';
      data.push({ range: `${TAB}!B${rowNum}:M${rowNum}`, values: [row] });
      const concat = eTpl ? predictConcat(eTpl, a.C, a.D) : `${a.C} ${a.D ?? ''}`.trim();
      console.log(`  APPEND r${rowNum}: ${a.B} | ${a.C} ${a.D ?? ''} | ${a.F ?? '—'} → ${a.G ?? '—'} | ${a.K}` +
        ` → link [${(a.link || []).join(',')}] = '${concat}'`);
      for (const id of a.link || []) sbPatches.push({ id, linked_activity: concat, sheetId: sid, rowNum });
    }

    if (WRITE && data.length) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: sid,
        requestBody: { valueInputOption: 'USER_ENTERED', data },
      });
      // re-read the appended/updated concats so linked_activity matches the
      // sheet EXACTLY (formula conventions vary per sheet)
      const recheck = await sheets.spreadsheets.values.get({
        spreadsheetId: sid, range: `${TAB}!B1:M200`, valueRenderOption: 'UNFORMATTED_VALUE',
      });
      const fresh = recheck.data.values || [];
      for (const p of sbPatches.filter((p) => p.sheetId === sid)) {
        const actual = fresh[p.rowNum - 1]?.[3];
        if (actual && String(actual) !== p.linked_activity) {
          console.log(`  (concat correction r${p.rowNum}: '${p.linked_activity}' → '${actual}')`);
          p.linked_activity = String(actual);
        }
      }
      console.log(`  ✓ wrote ${data.length} range(s)`);
    }
  }

  console.log(`\n--- Supabase linked_activity patches (${sbPatches.length}) ---`);
  for (const p of sbPatches) console.log(`  id ${p.id} → '${p.linked_activity}'`);

  if (WRITE) {
    for (const p of sbPatches) {
      const res = await fetch(`${SB_URL}/summer_timelines?id=eq.${p.id}`, {
        method: 'PATCH',
        headers: {
          apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
          'Content-Type': 'application/json', Prefer: 'return=minimal',
        },
        body: JSON.stringify({ linked_activity: p.linked_activity }),
      });
      if (!res.ok) console.log(`  !! PATCH id ${p.id} failed: ${res.status} ${await res.text()}`);
    }
    console.log('✓ Supabase patches sent');
  } else {
    console.log('\nDRY RUN — nothing written. Re-run with --write to execute.');
  }
})().catch((e) => { console.error('ERR:', e.stack || e.message); process.exit(1); });
