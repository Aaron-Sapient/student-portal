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

// ── Grammar (kind='grammar') ─────────────────────────────────────────────────
// "Verb confusion" quizzes. Content shape: an ordered jsonb array of question
// items (order is authored & preserved — not shuffled — so the warm-up → apply →
// synthesize sequence stays intact). Three item types:
//   - 'classify' : { word, answer }            → "Is <word> a verb?" (Verb / Not a verb)
//   - 'fill'     : { sentence, options, answer } → pick the form that fits the blank
//   - 'odd'      : { options, answer }           → 3 guaranteed not-verbs + 1 verb;
//                                                  pick the odd one out (the verb)
// answer ∈ {'verb','not_verb'} for classify; the literal option text for fill/odd.
// Option keys are positional indices into the ORIGINAL options array, so a shuffled
// payload never reveals the answer and scoring is collision-proof for duplicate text.

const CLASSIFY_LABEL = (k) =>
  k === 'verb' ? 'Verb' : k === 'not_verb' ? 'Not a verb' : null

const ODD_PROMPT =
  'Three of these can never be a verb on their own — one is a real verb. Which is the odd one out?'

// Build a shuffled, answer-key-free grammar quiz from content.
export function buildGrammarQuiz(content) {
  const questions = (content || []).map((item) => {
    const base = { id: item.id, target: item.id, type: item.type }

    if (item.type === 'classify') {
      return {
        ...base,
        prompt: `Is “${item.word}” a verb?`,
        promptLabel: 'Verb or not a verb?',
        options: [
          { key: 'verb', label: 'Verb' },
          { key: 'not_verb', label: 'Not a verb' },
        ],
      }
    }

    // 'fill' | 'odd' — options are forms of a word; shuffle so position never leaks.
    const options = shuffle((item.options || []).map((label, i) => ({ key: String(i), label })))
    return {
      ...base,
      prompt: item.type === 'fill' ? item.sentence : ODD_PROMPT,
      promptLabel: item.type === 'fill' ? 'Fill in the blank' : 'Odd one out',
      options,
    }
  })

  return { questions } // authored order preserved (no question shuffle for grammar)
}

// Score grammar responses against canonical content. responses:
// [{ target, selectedKey }]. Returns a single grammar_score + per-question review.
export function scoreGrammarResponses(content, responses) {
  const items = content || []
  const byTarget = new Map((responses || []).map((r) => [r.target, r]))

  let grammar_score = 0

  const answers = items.map((item) => {
    const r = byTarget.get(item.id) || {}
    const selectedKey = r.selectedKey != null ? String(r.selectedKey) : null

    let correctKey
    let selectedLabel
    let correctLabel
    let title
    let detail = null

    if (item.type === 'classify') {
      correctKey = item.answer // 'verb' | 'not_verb'
      selectedLabel = CLASSIFY_LABEL(selectedKey)
      correctLabel = CLASSIFY_LABEL(item.answer)
      title = `Is “${item.word}” a verb?`
    } else {
      const opts = item.options || []
      const idx = selectedKey != null ? parseInt(selectedKey, 10) : -1
      correctKey = String(opts.indexOf(item.answer))
      selectedLabel = idx >= 0 && idx < opts.length ? opts[idx] : null
      correctLabel = item.answer
      title = item.type === 'fill' ? item.sentence : 'Odd one out — which is the verb?'
      if (item.type === 'odd') detail = opts.join('   ·   ')
    }

    const correct = selectedKey != null && selectedKey === correctKey
    if (correct) grammar_score++

    return {
      id: item.id,
      type: item.type,
      title,
      detail,
      selectedLabel,
      correctLabel,
      correct,
    }
  })

  return { grammar_score, total: answers.length, answers }
}
