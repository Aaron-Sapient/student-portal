#!/usr/bin/env node
/**
 * pushDocument.cjs — put ONE file in front of ONE student (consultant brief §4).
 *
 *   node scripts/pushDocument.cjs <student-email-or-uuid> <path> [--title "…"] [--editable]
 *                                 [--reset-edits] [--dry-run] [--yes]
 *
 * What it does, in order: reads the file; computes the sha256; resolves the student
 * by EMAIL or uuid (a bare name is refused — there are two Chens); prints
 * `Pushing "<title>" to <Name> (class of 20xx)` and waits for Enter (skip with
 * --yes); decides text column vs bucket by extension + size (html/md <= 1 MB →
 * `documents.body`; pdf or anything larger → Storage bucket `documents`); upserts on
 * (student_id, slug); prints the URL.
 *
 * Idempotent: same (student, slug) + same sha → "unchanged", exit 0. Different sha →
 * replaces body/pushed_at and LEAVES document_edits alone (the student keeps their
 * working copy). --reset-edits deletes the edit row after printing it to the terminal.
 *
 * --dry-run does every read and prints the row it WOULD upsert; it never writes.
 * Service-role key from .env.local (staff laptop only; never a server).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { createClient } = require('@supabase/supabase-js');

const BUCKET = 'documents';
const MAX_BODY_BYTES = 1024 * 1024;
const KIND_BY_EXT = { '.html': 'html', '.htm': 'html', '.md': 'markdown', '.markdown': 'markdown', '.pdf': 'pdf' };
const MIME_BY_KIND = { html: 'text/html', markdown: 'text/markdown', pdf: 'application/pdf' };

function loadEnv() {
  const file = path.join(__dirname, '..', '.env.local');
  const env = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    env[m[1]] = m[2].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  }
  return env;
}

function parseArgs(argv) {
  const out = { positional: [], title: null, editable: false, resetEdits: false, dryRun: false, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--title') out.title = argv[++i];
    else if (a === '--editable') out.editable = true;
    else if (a === '--reset-edits') out.resetEdits = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--yes' || a === '-y') out.yes = true;
    else if (a.startsWith('--')) throw new Error(`Unknown flag ${a}`);
    else out.positional.push(a);
  }
  return out;
}

// "College List v2_EXTERNAL_EDITABLE.html" → title "College List v2", slug "college-list-v2"
function labelFromFilename(filename) {
  let base = filename.replace(/\.[^.]+$/, '');
  base = base.replace(/[ _-]*external[ _-]*editable\s*$/i, '');
  base = base.replace(/[ _-]*external\s*$/i, '');
  return base.replace(/_+/g, ' ').trim() || filename;
}
function slugify(label) {
  return label
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-');
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a); }));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [who, filePath] = args.positional;
  if (!who || !filePath) {
    console.error('usage: pushDocument.cjs <student-email-or-uuid> <path> [--title "…"] [--editable] [--reset-edits] [--dry-run] [--yes]');
    process.exit(2);
  }
  const isUuid = /^[0-9a-f-]{36}$/i.test(who);
  if (!isUuid && !who.includes('@')) {
    console.error(`Refusing a bare name ("${who}"): pass the student's email or uuid — there are two Chens.`);
    process.exit(2);
  }

  const env = loadEnv();
  const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const pushedBy = env.PUSH_DOCUMENT_AS || 'aaron@admissions.partners';

  // 1. the file
  const abs = path.resolve(filePath);
  const bytes = fs.readFileSync(abs);
  const ext = path.extname(abs).toLowerCase();
  const kind = KIND_BY_EXT[ext];
  if (!kind) {
    console.error(`Unsupported extension ${ext}: documents are html, markdown, or pdf.`);
    process.exit(2);
  }
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  const filename = path.basename(abs);
  const title = args.title || labelFromFilename(filename);
  const slug = slugify(title);
  const editable = args.editable || /_external_editable/i.test(filename);
  const toBucket = kind === 'pdf' || bytes.length > MAX_BODY_BYTES;

  // 2. the student
  let q = sb.from('students').select('id, name, class, student_email, status');
  q = isUuid ? q.eq('id', who) : q.eq('student_email', who.trim().toLowerCase());
  const { data: students, error: sErr } = await q.limit(2);
  if (sErr) throw sErr;
  if (!students || students.length !== 1) {
    console.error(`Student not resolved for "${who}" (${students ? students.length : 0} matches).`);
    process.exit(1);
  }
  const student = students[0];
  const classYear = String(student.class || '').replace(/^'/, '');

  // 3. what exists already
  const { data: existing, error: eErr } = await sb
    .from('documents')
    .select('id, body_sha256, storage_path')
    .eq('student_id', student.id)
    .eq('slug', slug)
    .maybeSingle();
  if (eErr && !/schema cache|does not exist/i.test(eErr.message)) throw eErr;
  if (eErr) console.warn(`(documents table not reachable yet: ${eErr.message})`);

  const storagePath = toBucket ? `${student.id}/${slug}${ext}` : null;
  const row = {
    student_id: student.id,
    slug,
    title,
    kind,
    body: toBucket ? null : bytes.toString('utf8'),
    storage_path: storagePath,
    body_sha256: sha,
    editable,
    pushed_at: new Date().toISOString(),
    pushed_by: pushedBy,
  };

  console.log(`Pushing "${title}" to ${student.name} (class of ${classYear.length === 2 ? `20${classYear}` : classYear})`);
  console.log(`  file    ${abs} (${bytes.length} bytes, ${kind}${editable ? ', editable' : ''})`);
  console.log(`  slug    ${slug}`);
  console.log(`  sha256  ${sha}`);
  console.log(`  home    ${toBucket ? `bucket ${BUCKET}/${storagePath}` : 'documents.body'}`);
  console.log(`  status  ${existing ? (existing.body_sha256 === sha ? 'unchanged' : `update ${existing.id}`) : 'new row'}`);

  if (args.dryRun) {
    console.log('\n--dry-run: would upsert (body elided):');
    console.log(JSON.stringify({ ...row, body: row.body == null ? null : `<${row.body.length} chars>` }, null, 2));
    if (args.resetEdits) console.log('--dry-run: would delete the document_edits row (after printing it).');
    return;
  }
  if (existing && existing.body_sha256 === sha && !args.resetEdits) {
    console.log('unchanged');
    return;
  }
  if (!args.yes) {
    const a = await ask('Press Enter to push (anything else aborts): ');
    if (a.trim() !== '') { console.log('aborted'); process.exit(1); }
  }

  if (toBucket) {
    const { error: upErr } = await sb.storage
      .from(BUCKET)
      .upload(storagePath, bytes, { contentType: MIME_BY_KIND[kind], upsert: true });
    if (upErr) throw upErr;
  }
  const { data: saved, error: wErr } = await sb
    .from('documents')
    .upsert(row, { onConflict: 'student_id,slug' })
    .select('id')
    .single();
  if (wErr) throw wErr;

  if (args.resetEdits) {
    const { data: edit } = await sb.from('document_edits').select('*').eq('document_id', saved.id).maybeSingle();
    if (edit) {
      console.log('--reset-edits: deleting this working copy (kept here in scrollback):\n');
      console.log(edit.body);
      const { error: dErr } = await sb.from('document_edits').delete().eq('document_id', saved.id);
      if (dErr) throw dErr;
    }
  }
  console.log(`\npushed ${saved.id}\n  https://portal.admissions.partners/api/files/${saved.id}`);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
