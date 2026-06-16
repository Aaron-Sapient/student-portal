// One-off: regenerate specific students' written reports through the current
// (improved, never-negative) prompt in lib/generateReport.js. Reads .env.local
// the same way scoreStudents.cjs does, then calls triggerReportGeneration —
// which appends a fresh row to the master WrittenReports tab (status unchecked)
// and pings the review inbox. The old unsent drafts are left in place.
//
//   node scripts/nas/regenReports.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envFile = fs.readFileSync(path.join(__dirname, '..', '..', '.env.local'), 'utf8');
const envGet = (k) => {
  const m = envFile.match(new RegExp('^' + k + '=(.*)$', 'm'));
  return m ? m[1].replace(/^['"]|['"]$/g, '') : undefined;
};
for (const k of [
  'GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_PRIVATE_KEY', 'ANTHROPIC_API_KEY',
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'NEXT_PUBLIC_BASE_URL',
]) {
  const v = envGet(k);
  if (v != null) process.env[k] = v;
}

const { triggerReportGeneration } = await import('../../lib/generateReport.js');

// Aarav already regenerated successfully on the first pass; re-running him would
// append a duplicate draft. Only Aasrith failed (trailing-space name bug, now
// fixed in lib/generateReport.js), so re-run just him.
const TARGETS = [
  { name: 'Aasrith Dwarampudi', sheetId: '1IoB5P8nOORcBfeERQOsL7Ij09XfeEgqPtkaI49SRS5Q' },
];

for (const t of TARGETS) {
  process.stdout.write(`Regenerating ${t.name} … `);
  await triggerReportGeneration(t.name, t.sheetId);
  console.log('done');
}
console.log('All regenerations complete.');
