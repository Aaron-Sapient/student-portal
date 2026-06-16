import sanitizeHtml from 'sanitize-html'

// Student-editable HTML is pasted from arbitrary external sources (their own
// LLM, a doc, anywhere) and is later rendered to the student, their parents, and
// to Aaron in the developer panel. The editor preview is a sandboxed iframe, but
// these other readers may render the stored HTML directly — so we strip anything
// executable on SAVE. Documents are static reports: rich text + inline styling is
// allowed; scripts, event handlers, javascript: URLs, and embeds are not.
const OPTIONS = {
  // Start from a generous default set so document formatting survives, plus the
  // structural/section tags reports use. No <script>, <iframe>, <object>, etc.
  allowedTags: [
    ...sanitizeHtml.defaults.allowedTags,
    'img',
    'figure',
    'figcaption',
    'header',
    'footer',
    'section',
    'article',
    'main',
    'aside',
    'style',
    'h1',
    'h2',
    'span',
  ],
  allowedAttributes: {
    '*': ['style', 'class', 'id', 'align', 'width', 'height', 'colspan', 'rowspan'],
    a: ['href', 'name', 'target', 'rel'],
    img: ['src', 'alt', 'title', 'width', 'height'],
  },
  // Inline <style> blocks are common in exported reports — keep them, but
  // sanitize-html will still drop event-handler attributes and js: URLs.
  allowVulnerableTags: false,
  allowedSchemes: ['http', 'https', 'mailto', 'tel', 'data'],
  allowedSchemesByTag: { img: ['http', 'https', 'data'] },
  // Drop on* handlers and other dangerous attributes implicitly (not allowlisted).
  allowProtocolRelative: true,
  parser: { lowerCaseTags: false },
}

// Returns a sanitized copy of the input HTML. Always run before persisting a
// student-saved revision.
export function sanitizeDocumentHtml(html) {
  return sanitizeHtml(String(html ?? ''), OPTIONS)
}
