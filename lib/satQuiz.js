// Quiz building + scoring for the public /sat surface. Pure & server-side: the
// answer key lives here and in Supabase (sat_quizzes.content), never in the GET
// payload sent to the browser. Scoring is stateless — re-derived from canonical
// content — so a client can't spoof option labels or correctness.
//
// Vocab content shape: [{ word, definition, connotation }], connotation ∈
// 'positive' | 'neutral' | 'negative'. Each rendered question tests one word
// (the "target", identified by its slug) two ways:
//   - type 'definition' : prompt = the WORD, pick the right DEFINITION
//   - type 'word'       : prompt = the DEFINITION, pick the right WORD
// plus a connotation choice on every question.

export const CONNOTATIONS = ['positive', 'neutral', 'negative']

export function wordSlug(word) {
  return String(word).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')
}

function shuffle(arr) {
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// Build a shuffled, answer-key-free quiz from vocab content.
export function buildVocabQuiz(content) {
  const items = (content || []).map((it) => ({ ...it, slug: wordSlug(it.word) }))
  const n = items.length

  // Roughly half "choose the definition", half "choose the word".
  const order = shuffle(items.map((_, i) => i))
  const halfDef = new Set(order.slice(0, Math.ceil(n / 2)))

  const questions = items.map((item, idx) => {
    const type = halfDef.has(idx) ? 'definition' : 'word'
    const others = items.filter((_, i) => i !== idx)
    const distractors = shuffle(others).slice(0, 3)
    const pool = shuffle([item, ...distractors])

    const options = pool.map((p) => ({
      key: p.slug,
      label: type === 'definition' ? p.definition : p.word,
    }))

    return {
      id: item.slug,           // == target; only identifies which word, not the answer
      target: item.slug,
      type,
      prompt: type === 'definition' ? item.word : item.definition,
      promptLabel: type === 'definition' ? 'Choose the definition' : 'Choose the word',
      options,
      connotationOptions: CONNOTATIONS,
    }
  })

  return { questions: shuffle(questions) }
}

// Score submitted responses against canonical content. responses:
// [{ target, type, selectedKey, selectedConnotation }]. Returns the two
// sub-scores + a full per-question review record (answers) for storage/render.
export function scoreVocabResponses(content, responses) {
  const items = (content || []).map((it) => ({ ...it, slug: wordSlug(it.word) }))
  const bySlug = new Map(items.map((it) => [it.slug, it]))

  let vocab_score = 0
  let connotation_score = 0

  const answers = (responses || []).map((r) => {
    const item = bySlug.get(r.target)
    const type = r.type === 'word' ? 'word' : 'definition'
    const picked = r.selectedKey ? bySlug.get(r.selectedKey) : null

    const mainCorrect = !!item && r.selectedKey === item.slug
    const connCorrect = !!item && r.selectedConnotation === item.connotation
    if (mainCorrect) vocab_score++
    if (connCorrect) connotation_score++

    return {
      target: r.target,
      type,
      word: item ? item.word : r.target,
      prompt: item ? (type === 'definition' ? item.word : item.definition) : '',
      // What the student picked vs. what was correct (labels reconstructed
      // server-side from content, never trusted from the client).
      selectedLabel: picked ? (type === 'definition' ? picked.definition : picked.word) : null,
      correctLabel: item ? (type === 'definition' ? item.definition : item.word) : null,
      mainCorrect,
      selectedConnotation: r.selectedConnotation || null,
      correctConnotation: item ? item.connotation : null,
      connCorrect,
    }
  })

  return { vocab_score, connotation_score, total: answers.length, answers }
}
