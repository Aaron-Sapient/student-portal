// Pure, dependency-free college-name → stable key. Lives on its own (no server
// imports) so both the server sync (lib/writingDocs.js) and client link-builders
// (the Colleges cards) can use it. Matching tabs on this — never the editable
// title — is what keeps the college→tab sync rename-safe and idempotent.
export function normalizeKey(name) {
  return String(name ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritical marks
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}
