// Fuzzy student matching for the dev/admin lists. A query matches when every
// whitespace-separated token is either a substring of the haystack or a
// subsequence of a single word in it — so "jhn" finds "John", "aron" finds
// "Aaron", and "smith 27" finds a Smith in the class of '27.

const norm = (s) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    // strip combining diacritics (U+0300–U+036F)
    .replace(/[̀-ͯ]/g, '');

function isSubsequence(needle, word) {
  let i = 0;
  for (const ch of word) {
    if (ch === needle[i]) i++;
  }
  return i === needle.length;
}

export function fuzzyMatch(query, haystack) {
  const tokens = norm(query).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const hay = norm(haystack);
  const words = hay.split(/[^a-z0-9]+/).filter(Boolean);
  return tokens.every((t) => hay.includes(t) || words.some((w) => isSubsequence(t, w)));
}

const GRADE_WORDS = { 9: 'freshman', 10: 'sophomore', 11: 'junior', 12: 'senior' };

// name + every way someone might type the year: the Class column as written
// ("'27"), the four-digit year ("2027"), and the current grade level ("12",
// "12th", "senior"). `grade` is lib/scores' gradeFromClass(classStr).
export function studentHaystack(name, classStr, grade) {
  const parts = [name, classStr];
  const m = String(classStr ?? '').match(/(\d{2})\s*$/);
  if (m) parts.push(`20${m[1]}`);
  if (grade != null) parts.push(`${grade}`, `${grade}th`, GRADE_WORDS[grade] || '');
  return parts.filter(Boolean).join(' ');
}
