import fs from 'node:fs/promises'
import path from 'node:path'
import { getGoogleDriveClient } from '@/lib/google'

// Root of the local "Student Profiles" tree on Aaron's Mac. Each student folder is
// `<root>/<gradYear>/<Name> <gradYear>` and holds files; only those whose basename
// contains "_EXTERNAL" are student-facing (everything else is internal).
// Override with STUDENT_PROFILES_DIR. This is a DEV-only source — the path does not
// exist on Vercel, so callers must tolerate it being absent.
const PROFILES_ROOT =
  process.env.STUDENT_PROFILES_DIR ||
  '/Users/aaron/Documents/VS Code/AP-Counseling/01. Student Profiles'

const EXTERNAL_MARK = '_external'
// A second species of student-facing file: "..._EXTERNAL_EDITABLE.html". These
// open in the in-portal editor (raw HTML + preview) and fork into Supabase on
// save, instead of being served read-only. (Note: this string CONTAINS the
// plain `_external` marker, so editable files also pass the EXTERNAL_MARK test.)
const EDITABLE_MARK = '_external_editable'

// Where an editable file's `openUrl` points. The student portal (default) sends
// it to the full-screen HTML editor at /edit (outside the portal chrome, opened
// in a new tab); the parent portal overrides editableUrlBase to a read-only
// render endpoint and sets editableInteractive=false so the row reads as a
// normal report opening in a new tab. `base` must end in '?' or '&'.
const DEFAULT_EDITABLE_BASE = '/edit?'
function editableOpenUrl(filename, base) {
  return `${base}file=${encodeURIComponent(filename)}`
}

// Map a file extension to a coarse kind the UI can icon/label by.
export function fileKind(ext) {
  const e = ext.replace(/^\./, '').toLowerCase()
  if (e === 'pdf') return 'pdf'
  if (e === 'html' || e === 'htm') return 'doc'
  if (e === 'md' || e === 'markdown') return 'doc'
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'heic'].includes(e)) return 'image'
  if (['doc', 'docx'].includes(e)) return 'doc'
  if (['xls', 'xlsx', 'csv'].includes(e)) return 'sheet'
  if (['ppt', 'pptx'].includes(e)) return 'slides'
  return 'file'
}

// "Sample Summer Plan_EXTERNAL.html" -> "Sample Summer Plan". Strips the _EXTERNAL
// marker (any case) and the extension, then tidies separators.
export function prettyLabel(filename) {
  let base = filename.replace(/\.[^.]+$/, '')
  // Strip the editable marker first (it ends in "_EDITABLE", so the plain
  // "_external$" rule below wouldn't match it), then the plain _EXTERNAL marker.
  base = base.replace(/[ _-]*external[ _-]*editable\s*$/i, '')
  base = base.replace(/[ _-]*external\s*$/i, '')
  base = base.replace(/[_]+/g, ' ').trim()
  return base || filename
}

// Build the absolute path to a student's local profile folder, or null if we can't
// form one. Folder convention: "<Name> <gradYear>" under the grad-year directory.
export function localStudentDir(name, gradYear) {
  if (!name || !gradYear) return null
  const year = String(gradYear).trim().replace(/^'/, '').replace(/^(\d{2})$/, '20$1')
  const safeName = String(name).trim()
  if (!safeName || !/^\d{4}$/.test(year)) return null
  return path.join(PROFILES_ROOT, year, `${safeName} ${year}`)
}

// List the student-facing (_EXTERNAL) files in their local profile folder. Returns []
// when the folder doesn't exist (e.g. on Vercel) — never throws for a missing dir.
export async function listLocalExternalFiles(
  name,
  gradYear,
  { editableUrlBase = DEFAULT_EDITABLE_BASE, editableInteractive = true } = {}
) {
  const dir = localStudentDir(name, gradYear)
  if (!dir) return []
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return [] // no local fs / folder absent
  }
  const out = []
  for (const ent of entries) {
    if (!ent.isFile()) continue
    if (!ent.name.toLowerCase().includes(EXTERNAL_MARK)) continue
    const ext = path.extname(ent.name)
    let modified = null
    let size = null
    try {
      const st = await fs.stat(path.join(dir, ent.name))
      modified = st.mtime.toISOString()
      size = st.size
    } catch {
      /* ignore stat failure */
    }
    const editableFile = ent.name.toLowerCase().includes(EDITABLE_MARK)
    out.push({
      id: `local:${ent.name}`,
      source: 'local',
      // Local files are _EXTERNAL by construction (filtered above) → always a report.
      isReport: ent.name.toLowerCase().includes(EXTERNAL_MARK),
      // Only flag as editable for the interactive (student) viewer.
      isEditable: editableFile && editableInteractive,
      name: prettyLabel(ent.name),
      filename: ent.name,
      kind: fileKind(ext),
      ext: ext.replace(/^\./, '').toLowerCase(),
      modified,
      size,
      // Editable files route to the editor (student) or canonical render
      // (parent); everything else streams raw.
      openUrl: editableFile
        ? editableOpenUrl(ent.name, editableUrlBase)
        : `/api/files/local?name=${encodeURIComponent(ent.name)}`,
    })
  }
  return out
}

// Resolve and read a single local _EXTERNAL file for streaming. Sanitizes `name` to a
// basename and verifies it's an _EXTERNAL file inside the student's own folder — blocks
// path traversal and any access to internal files. Returns {buffer, ext, filename} or null.
export async function readLocalExternalFile(name, gradYear, requestedName) {
  const dir = localStudentDir(name, gradYear)
  if (!dir) return null
  const base = path.basename(String(requestedName || '')) // strip any path components
  if (!base || !base.toLowerCase().includes(EXTERNAL_MARK)) return null
  const full = path.join(dir, base)
  // Defense in depth: the resolved path must still live directly under `dir`.
  if (path.dirname(full) !== dir) return null
  try {
    const buffer = await fs.readFile(full)
    return { buffer, ext: path.extname(base).replace(/^\./, '').toLowerCase(), filename: base }
  } catch {
    return null
  }
}

// Pull a Drive folder ID out of a Sheets grid cell (the `🔎 Overview!L2` link). The link
// may be a real hyperlink, a rich-link/smart-chip, a link applied to a text run, or just a
// pasted URL in the text. Returns the folder ID or null.
export function extractDriveFolderId(cell) {
  if (!cell) return null
  const candidates = []
  if (cell.hyperlink) candidates.push(cell.hyperlink)
  for (const run of cell.textFormatRuns || []) {
    const uri = run?.format?.link?.uri
    if (uri) candidates.push(uri)
  }
  for (const run of cell.chipRuns || []) {
    const uri = run?.chip?.richLinkProperties?.uri
    if (uri) candidates.push(uri)
  }
  if (cell.formattedValue) candidates.push(cell.formattedValue)
  for (const c of candidates) {
    const id = driveFolderIdFromUrl(c)
    if (id) return id
  }
  return null
}

export function driveFolderIdFromUrl(url) {
  if (!url || typeof url !== 'string') return null
  // .../folders/<id>  or  ?id=<id>  or  /drive/u/0/folders/<id>
  const m =
    url.match(/\/folders\/([a-zA-Z0-9_-]+)/) || url.match(/[?&]id=([a-zA-Z0-9_-]+)/)
  return m ? m[1] : null
}

// ── Shared assembly (student + parent file routes) ───────────────────────────

// Drive shows everything in the folder, but exported files keep the internal
// "_EXTERNAL" marker (and extension) in their filename — strip it for display so
// they read cleanly. Non-_EXTERNAL items keep their name as-is.
function driveDisplayName(name) {
  return /_external/i.test(name) ? prettyLabel(name) : name
}

// Map a Drive mimeType to the same coarse "kind" buckets the local files use.
function driveKind(mimeType, name) {
  if (!mimeType) return fileKind(name || '')
  if (mimeType === 'application/vnd.google-apps.folder') return 'folder'
  if (mimeType.includes('document') || mimeType === 'application/pdf') return 'doc'
  if (mimeType.includes('spreadsheet')) return 'sheet'
  if (mimeType.includes('presentation')) return 'slides'
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType === 'application/pdf') return 'pdf'
  return fileKind(name || '')
}

const OVERVIEW_LINK_FIELDS =
  'sheets(data(rowData(values(formattedValue,hyperlink,textFormatRuns(format(link(uri))),chipRuns(chip(richLinkProperties(uri)))))))'

// Resolve the student's Drive folder from their sheet's 🔎 Overview tab
// (H2 primary, L2 fallback — the link may be a smart-chip, hyperlink, or URL).
export async function resolveStudentFolderId(sheets, studentSheetId) {
  const grid = await sheets.spreadsheets.get({
    spreadsheetId: studentSheetId,
    ranges: ["'🔎 Overview'!H2", "'🔎 Overview'!L2"],
    fields: OVERVIEW_LINK_FIELDS,
  })
  const cellOf = (i) =>
    grid.data.sheets?.[0]?.data?.[i]?.rowData?.[0]?.values?.[0] || null
  return extractDriveFolderId(cellOf(0)) || extractDriveFolderId(cellOf(1))
}

// Full file listing for a student sheet: Overview metadata, Drive folder
// contents, local _EXTERNAL files (dev-only), deduped and merged newest-first.
// `driveProxyBase` parameterizes the proxied openUrl so the parent routes can
// point HTML files at their own scoped proxy ('/api/files/drive?' by default —
// must end in '?' or '&', the file id is appended as `id=<id>`).
export async function listStudentFiles(
  sheets,
  studentSheetId,
  {
    driveProxyBase = '/api/files/drive?',
    editableUrlBase = DEFAULT_EDITABLE_BASE,
    editableInteractive = true,
  } = {}
) {
  // One grid read pulls the student's name (B2), grad year (C3) and the Drive
  // folder link (H2 primary, L2 fallback).
  const grid = await sheets.spreadsheets.get({
    spreadsheetId: studentSheetId,
    ranges: [
      "'🔎 Overview'!B2",
      "'🔎 Overview'!C3",
      "'🔎 Overview'!H2",
      "'🔎 Overview'!L2",
    ],
    fields: OVERVIEW_LINK_FIELDS,
  })
  const cellOf = (i) =>
    grid.data.sheets?.[0]?.data?.[i]?.rowData?.[0]?.values?.[0] || null
  const studentName = cellOf(0)?.formattedValue || ''
  const gradYear = cellOf(1)?.formattedValue || ''
  const folderId = extractDriveFolderId(cellOf(2)) || extractDriveFolderId(cellOf(3))

  // ── Local _EXTERNAL files (dev-only; silently empty on Vercel) ──────────────
  const localFiles = await listLocalExternalFiles(studentName, gradYear, {
    editableUrlBase,
    editableInteractive,
  })

  // ── Google Drive files ──────────────────────────────────────────────────────
  let driveFiles = []
  let drive = { status: folderId ? 'ok' : 'no_folder', folderId, message: null }
  if (folderId) {
    try {
      const driveClient = getGoogleDriveClient()
      const list = await driveClient.files.list({
        q: `'${folderId}' in parents and trashed=false`,
        orderBy: 'modifiedTime desc',
        pageSize: 200,
        fields: 'files(id,name,mimeType,modifiedTime,webViewLink,iconLink,size)',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      })
      driveFiles = (list.data.files || []).map((f) => {
        // Drive renders uploaded HTML as raw source — serve those through our
        // proxy so they render. Everything else opens in Drive (it previews
        // native docs, PDFs, and images fine).
        const proxyable = /^(text\/html|application\/xhtml\+xml)$/i.test(f.mimeType || '')
        const editableFile = /_external_editable/i.test(f.name || '')
        return {
          id: `drive:${f.id}`,
          source: 'drive',
          // The "_EXTERNAL" marker = a report we exported for the student/parent,
          // vs. an ordinary file living in their Drive folder.
          isReport: /_external/i.test(f.name || ''),
          // Only flag as editable for the interactive (student) viewer.
          isEditable: editableFile && editableInteractive,
          name: driveDisplayName(f.name),
          filename: f.name,
          kind: driveKind(f.mimeType, f.name),
          ext: '',
          modified: f.modifiedTime || null,
          size: f.size ? Number(f.size) : null,
          // Editable files route to the editor (student) or canonical render
          // (parent); everything else opens in Drive or streams via the proxy.
          openUrl: editableFile
            ? editableOpenUrl(f.name, editableUrlBase)
            : proxyable
              ? `${driveProxyBase}id=${f.id}`
              : f.webViewLink || `https://drive.google.com/file/d/${f.id}/view`,
          iconLink: f.iconLink || null,
        }
      })
    } catch (err) {
      const msg = err?.message || String(err)
      let status = 'error'
      if (/has not been used in project|SERVICE_DISABLED|accessNotConfigured/i.test(msg))
        status = 'disabled'
      else if (err?.code === 404 || /notFound/i.test(msg)) status = 'not_found'
      else if (err?.code === 403 || /permission|forbidden/i.test(msg)) status = 'no_access'
      drive = { status, folderId, message: msg }
    }
  }

  // Drive is canonical (it's what prod serves) — drop local entries whose
  // filename already exists in Drive to avoid showing the same file twice in dev.
  const driveNames = new Set(driveFiles.map((f) => f.filename.toLowerCase()))
  const dedupedLocal = localFiles.filter(
    (f) => !driveNames.has(f.filename.toLowerCase())
  )

  // Merge, newest first; entries with no date sink to the bottom.
  const files = [...dedupedLocal, ...driveFiles].sort((a, b) => {
    if (!a.modified && !b.modified) return a.name.localeCompare(b.name)
    if (!a.modified) return 1
    if (!b.modified) return -1
    return b.modified.localeCompare(a.modified)
  })

  return {
    studentName,
    files,
    drive,
    counts: { local: dedupedLocal.length, drive: driveFiles.length },
  }
}

// Stream a Drive file's bytes with its real Content-Type, gated on the file
// being a DIRECT child of the given folder (membership checked by listing the
// folder — Drive doesn't reliably expose `parents` on shared items). Returns a
// web Response in all cases.
export async function streamDriveFileFromFolder(folderId, fileId) {
  const drive = getGoogleDriveClient()
  let file
  try {
    const list = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: 'files(id,name,mimeType)',
      pageSize: 1000,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    })
    file = (list.data.files || []).find((f) => f.id === fileId)
  } catch {
    return new Response('Not found', { status: 404 })
  }
  if (!file) return new Response('Forbidden', { status: 403 })

  try {
    const media = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'arraybuffer' }
    )
    const buffer = Buffer.from(media.data)
    return new Response(buffer, {
      headers: {
        'Content-Type': file.mimeType || 'application/octet-stream',
        'Content-Disposition': `inline; filename="${(file.name || 'file').replace(/"/g, '')}"`,
        'Cache-Control': 'private, no-store',
      },
    })
  } catch {
    return new Response('Could not load file', { status: 502 })
  }
}

// Read the ORIGINAL bytes of a student's `_EXTERNAL_EDITABLE` file as a UTF-8
// string — Drive first (canonical in prod), local profile folder as a dev
// fallback. This is the baseline (revision 0) we capture the first time a
// student opens the editor, and it doubles as the ownership check for the
// editable API routes: returns null if the file isn't an editable file living
// in THIS student's own folder (so an arbitrary filename can't be saved/loaded).
export async function readEditableSource(sheets, studentSheetId, filename) {
  const base = path.basename(String(filename || ''))
  if (!base || !base.toLowerCase().includes(EDITABLE_MARK)) return null

  // One grid read: name (B2), grad year (C3), Drive folder link (H2 / L2).
  const grid = await sheets.spreadsheets.get({
    spreadsheetId: studentSheetId,
    ranges: [
      "'🔎 Overview'!B2",
      "'🔎 Overview'!C3",
      "'🔎 Overview'!H2",
      "'🔎 Overview'!L2",
    ],
    fields: OVERVIEW_LINK_FIELDS,
  })
  const cellOf = (i) =>
    grid.data.sheets?.[0]?.data?.[i]?.rowData?.[0]?.values?.[0] || null
  const studentName = cellOf(0)?.formattedValue || ''
  const gradYear = cellOf(1)?.formattedValue || ''
  const folderId = extractDriveFolderId(cellOf(2)) || extractDriveFolderId(cellOf(3))

  // ── Google Drive (canonical) ────────────────────────────────────────────────
  if (folderId) {
    try {
      const drive = getGoogleDriveClient()
      const list = await drive.files.list({
        q: `'${folderId}' in parents and trashed=false`,
        fields: 'files(id,name)',
        pageSize: 1000,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      })
      const match = (list.data.files || []).find(
        (f) => (f.name || '').toLowerCase() === base.toLowerCase()
      )
      if (match) {
        const media = await drive.files.get(
          { fileId: match.id, alt: 'media', supportsAllDrives: true },
          { responseType: 'arraybuffer' }
        )
        return Buffer.from(media.data).toString('utf8')
      }
    } catch {
      // fall through to the local dev fallback
    }
  }

  // ── Local profile folder (dev) ──────────────────────────────────────────────
  const local = await readLocalExternalFile(studentName, gradYear, base)
  return local ? local.buffer.toString('utf8') : null
}
