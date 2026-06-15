# Features Log — Portal Writing Platform (`redesign` branch)

A living capture of the "get students off Google Docs entirely" initiative and the
satellite features around it. This is a **brain-blast log**, not a spec — entries are
ideas and intentions until marked otherwise. Captured 2026-06-15.

> **Provenance discipline** (per global CLAUDE.md): everything below tagged `idea` is
> *intended*, not built. Things tagged `🧱 foundation-exists` were **verified in the code on
> this branch** on 2026-06-15 (file refs given). Don't let an idea get read back later as
> delivered — check the status tag and the referenced file before you rely on a claim.

Relationship to the other root docs:
- `northstar.md` — the design constitution (NS-1…NS-10). These features must obey it; cite rules by ID.
- `senior_tab.md` — the Colleges tab + senior program timeline; the docs platform is what the
  Colleges tab's essay links should eventually open *into*.
- `supabase-migration.md` — the storage substrate (student-hubs Supabase project).

**Status legend:** 💡 idea · 🧱 foundation-exists (verified) · 🚧 in-progress · ✅ done · 🅿️ parked
**Priority:** P0 (the headline) · P1 (needed for the headline to feel real) · P2 (delight / later)

---

## North Star for this initiative

> **The portal replaces Google Docs for all student writing.** Start with the senior essay
> program (Common App + UC PIQs + supplements), then expand to every writing project and task.
> Server-hosted documents with real version history, owned by us, that feel *better* than Docs —
> not a worse clone of it. (Aaron, 2026-06-15)

This is a **post-cutover roadmap item.** The `redesign → production` cutover is Mon 2026-06-15
(today) and does **not** gate on any of this; the writing platform ships after. Don't push
platform work to `main` ahead of the agreed cutover scope.

---

## Prior art on this branch — a SEPARATE feature, NOT the word processor (verified 2026-06-15)

> **Aaron, 2026-06-15: "HTML editor is completely separate from the word processor."**

There is already an **HTML "editable project dashboards" stack** on this branch — the
`_EXTERNAL_EDITABLE.html` files. It is its own feature: lightly-editable HTML **project dashboards**
(NOT counselor reports — those are the separate read-only `_EXTERNAL` files), and it is **not** the
foundation of the word processor described below. Don't conflate them or build the word processor on
top of it. It's listed here for one reason: it's a **working reference implementation of the
Supabase-backed version-history + identity pattern** the word processor will also need. Borrow the
*pattern*, not the *substrate*.

| Piece | File | What it does (verified) |
|---|---|---|
| Storage table | `lib/supabase.js` → `document_revisions` | Server-only **service-role** client for the student-hubs project. Table is RLS-and-no-policies (service role only). Columns seen in code: `student_sheet_id, student_email, filename, revision, html, source, note, created_at`. |
| Canonical read | `lib/editableDocs.js` | Latest saved revision's `html`, else the counselor's untouched original. Read-only; never writes. |
| Save / history API | `app/api/files/editable/route.js` | GET returns canonical HTML + revision history (`?revision=N` for a specific one / restore). POST sanitizes and appends `max(revision)+1`. Auth = Clerk session → master-sheet → **per-student-sheet ownership** check. `source` is hard-coded `'student'` on this route. |
| Sanitizer | `lib/htmlSanitize.js` | Strips executable HTML on **save**; allows rich text + inline styling + `<style>`. Treats docs as static (no scripts/embeds). |
| Editor surface | `/edit` page (`app/edit/`) | Full-screen **raw-HTML + preview** editor, opened in a new tab outside portal chrome. |
| Identity | `lib/identity.js` | Clerk email → role (`student` col J / `parent` col K-L) against the Master Sheet. |
| File sourcing | `lib/studentFiles.js` | Local "Student Profiles" tree (DEV-only, Aaron's Mac). `_EXTERNAL` = student-facing; `_EXTERNAL_EDITABLE.html` = opens in the editor and forks to Supabase on save. |
| Parent / dev read paths | `app/api/parent/files/editable/route.js`, `app/api/developer/documents/route.js` | Read-only renders for parents and Aaron's developer panel. |

**What transfers to the word processor:** the *shape* of version history (append-only revision rows,
restore-by-number), identity stamping via `lib/identity.js`, and a service-role Supabase home with a
student-visible key kept behind server-side auth. **What does not:** the HTML substrate, the raw-HTML
`/edit` surface, and the sanitize-on-save model — the word processor is a fresh, markdown-native build
(DOCS-7). Treat the table above as prior art, not as code to extend.

---

## DOCS-0 — ✅ Decided: the word processor is its own markdown-native build (P0)

Not a fork of, and not built on, the existing HTML editor — those are **completely separate**
(Aaron, 2026-06-15). The word processor is its **own** application: the Obsidian-style markdown engine
stolen from Helthy (DOCS-7), with its own editor surface, its own markdown storage, and its own
version history. The HTML "editable project dashboards" feature stays where it is and does its own job.

- **Why markdown, not the HTML stack:** the value here is the *typing experience* (live reveal, `@`
  chips, formats-itself-as-you-type) plus owning the data. The HTML dashboard editor delivers neither
  and exists for a different purpose.
- **What this means for points 7 & 8:** they're squarely markdown-engine problems now — no "HTML gives
  it for free" shortcut, because the word processor doesn't use the HTML stack. See DOCS-8 / DOCS-9 for
  the in-band hidden-marker and plain-text-serializer solutions.
- **Real open call (DOCS-7a):** the word processor stores **markdown**; wherever a read surface needs
  HTML, render markdown→HTML at read time. Decide per reader, not globally.

---

## DOCS-1 — 💡 Server-hosted docs replace Google Docs (P0) · THE HEADLINE

Move the senior essay program off Google Docs onto portal-native, server-hosted documents with
version history. Long-term: **all** students, **all** writing projects and tasks, zero Docs.

- Phase 1: senior essays (Common App personal statement, UC PIQs, per-school supplements).
- Phase 2: every writing task across all grades.
- Its own stack (markdown engine + its own revision store), separate from the HTML-dashboards feature.
- Obeys NS-8 (deep personalization — the doc knows which student, college, and milestone it belongs to).

## DOCS-2 — 💡 Sharing & permissions: link-view, tracked-edit (P0)

> "anyone with the link can view; aaron/ryan/student can edit (but track WHO edited in version history)"

- **Gap vs. the existing pattern (verified):** the HTML-dashboards stack today gates on Clerk
  **per-student-sheet ownership** — there is **no** "anyone with the link can view" path anywhere yet.
  A public/shareable **view token** is new work, and it touches the student-hubs **publishable key +
  RLS** (security-sensitive — that key is student-visible; view links must not widen write access).
  Flag for careful design.
- **Edit roster:** generalize beyond student. Today the save route hard-codes `source: 'student'`.
  Need `{student, aaron, ryan}` as editors, each writing revisions stamped with their identity.
- See DOCS-2a for the identity column.

## DOCS-2a — 💡 Version history must record WHO edited (P1)

> "track WHO edited in version history"

- The word processor needs its **own** revision history (it stores markdown, not HTML). The separate
  HTML-dashboards feature is **prior art** for how: append-only rows per doc, each stamped with an
  identity + timestamp, restore-by-number. (That feature's rows carry `student_email` + `source` +
  `created_at` — verified `app/api/files/editable/route.js` — but `source` is `'student'`-only there.)
- Reuse `lib/identity.js` (Clerk email → person) to stamp every revision as student / Aaron / Ryan —
  don't invent a second identity map.
- A revision schema to start from: `{doc_id, editor_identity, editor_role, revision, body_markdown,
  note, created_at}`. Build a "edited by X on date" timeline UI with restore on top.

---

## DOCS-7 — 🧱 Editor core already exists as a package: `Utils/md-editor` (P0 enabler)

**The editor is already built and extracted** into a project-agnostic, dependency-free vanilla-JS
package at **`/Users/aaron/Documents/VS Code/Claude/Utils/md-editor/`** (`md-editor.js` exposes
`window.MarkdownEditor = makeEditor`; `md-editor.css`). That folder is the **canonical source of
truth** — synced Mac↔NAS and pushed to projects by its own `sync.sh`/`targets.json`. It was extracted
from the Helthy meeting-notes editor. **Any feature/behavior change happens THERE first, then
`bash sync.sh`** — never hand-edit a synced copy (see project `CLAUDE.md`). Verified 2026-06-15.

What the package already provides (per its README, verified):
- **Single-string source of truth.** The markdown string round-trips losslessly; the DOM is a pure
  projection of it. (Internally: an inline tokenizer in absolute source offsets — the hard part.)
- **Obsidian-style live reveal.** Syntax marks hide until the caret enters their span.
- **`@` chips** for people/dates via `opts.people` (`@{person:…}` / `@{date:…}`, atomic pills that
  round-trip as their shown text). Repoint at the student/Aaron/Ryan roster; add doc chip types later.
- **GFM tables**, editable, with **drag-to-resize columns** persisted as a `%%cols:…%%` line.
- **`%%…%%` hidden comments / "ignore characters"** — in-band metadata that round-trips but the
  renderer hides. This is the primitive Aaron's point 7 builds on (see DOCS-8).
- **Themeable** via `--mde-*` custom properties (defaults = Helthy palette, incl. `--mde-clay-*`).
- **API:** `setText` / `getText` / `focus` / `dismiss`; `onInput` (debounce → save) / `onSave`
  (Cmd-S → flush). **Backend-agnostic** — it never touches the network; you persist `getText()`.

**What's left for the portal (the actual word-processor build):**
1. **Onboard** student-portal as a `files`-mode sync target (not done — only `helthy-hq` is wired).
2. **Skin** it: a claymorphic `--mde-*` override block in this repo's own CSS (DOCS-6, project CLAUDE.md).
3. **Persist:** `onInput`→debounced save, `onSave`→flush, store the `getText()` markdown in the word
   processor's **own** revision store (DOCS-2a), behind server-side auth — NOT the dashboards table.
4. **Build the chrome the package does NOT include:** tabs (DOCS-3), Option+/ palette (DOCS-4),
   sharing/permissions (DOCS-2), dark mode (DOCS-6), eggs (EGG-*).

> **DOCS-7a (open):** the package stores **markdown**. The word processor's own read surfaces (student,
> parent, Aaron's dev panel) each need to render it — decide markdown→HTML at read time vs. a rendered
> cache. Independent of the separate HTML-dashboards feature's `html` readers.

## DOCS-8 — 💡 Invisible styling stored in-band, markup NEVER shown (P1)

> Aaron's insight: "just like how `#` or `**` don't normally show, use CSS styling to let users set
> font to red etc. without it displaying onscreen. except, NEVER show the CSS styling to users."

- **The primitive already exists.** The package's `%%…%%` "ignore characters" syntax stores in-band
  metadata that round-trips through the markdown but the renderer hides — exactly this idea. Build
  styling on top of it.
- **One gap to close:** `%%…%%` *peeks open* when the caret is on/adjacent to its line (so it stays
  editable). Point 7 wants styling that **NEVER** reveals. So styling needs either a non-peeking
  variant of the hidden-span mechanism, or a `%%…%%`-encoded span whose styling is applied/removed
  only via the toolbar / Option+/ palette (DOCS-4) — never typed or shown as raw syntax.
- **Candidate encoding:** a marker like `%%c:red%%…%%/c%%` or chip grammar `@{c:red}…@{/c}`,
  `@{font:Poppins}…`, `@{ls:1.5}…` (line spacing) — both round-trip and stay hidden.
- **Lands in canonical first.** This is new editor behavior/syntax, so it's built in `Utils/md-editor`
  and synced out (project CLAUDE.md rule), not authored in this repo.
- (Aside: the separate HTML-dashboards tool sidesteps this with real inline styles — different tool.)

## DOCS-9 — 💡 Clean copy-paste out (no markdown / no CSS artifacts) (P1)

> "make sure users can copy-paste into another format (like Google Docs) without markdown or CSS
> formatting showing up, which will make it look like AI writing."

- **Mechanism:** a `copy`/`cut` handler on the editor surface that serializes the selected **source
  range** to clean output — strip all markdown markers, unwrap `@{…}` chips to their plain label, drop
  styling markers (DOCS-8) entirely. Offer plain text always; optionally also a `text/html` flavor so
  pasting into Docs keeps *intended* formatting as real rich text (not `**` soup). Helthy already does a
  mini version of this in table cells (paste strips newlines/pipes, copy is scoped) — generalize it to
  the whole surface.
- **Why it matters / credibility:** stray `**`/`#`/`@{…}` pasted into a college portal or Doc reads as
  AI-generated. This is what keeps portal-written essays from looking machine-made, not a nicety.

## DOCS-3 — 💡 Google-Docs-style document **tabs** (P1)

Copy Docs' tabs sidebar (see image: *Harvard / Princeton / Yale* tabs under "Document tabs").

- **Natural data model already exists:** per `senior_tab.md`, a student's supplemental essays
  (College List **column N**) are *tabs, not separate Docs* — one college, many supplements. So tabs
  aren't generic chrome; they map onto **college → supplement-essay** structure we already track.
- Left rail, add/reorder, nested sub-tabs (Docs supports child tabs → school ▸ individual prompts).
- Obeys NS-10 (neumorphic, icon-forward rail) and NS-9 (one tap to the essay you want).

## DOCS-4 — 💡 `Option+/` fuzzy command palette, frequency-weighted (P1)

Copy Docs' `Option+/` "search the menus" palette (see image: typing "poppins" surfaces the **Poppins**
font; also Redo, Find in document).

- Fuzzy-search **every** editor action: "bold", "heading 1", "line spacing", font names, "insert table",
  "dark mode", "new tab", etc.
- **Weight ranking by likely frequency of use** (bold/headings rank above obscure actions); learn from
  the user's own usage over time if cheap to do.
- This is the single keyboard surface that drives DOCS-8 styling without ever exposing syntax.
- Obeys NS-9 (collapses menu-diving to one keystroke).

## DOCS-6 — 💡 **Real** dark mode (P1)

> "REAL DARK MODE (suck it, Google Docs, I beat you to it)"

- Full theme-token swap for the editor *and* surrounding portal, not an inverted hack.
- **Tension to design around:** NS-10 is **neumorphic**, and neumorphism leans on light/shadow that's
  genuinely hard in dark palettes (low-contrast double-shadows muddy fast). Budget real design time for
  dark-neumorphic shadow tokens; don't assume a CSS variable flip is enough.
- Respect OS preference + manual override; persist the choice (and surface it in the DOCS-4 palette).

---

## Easter eggs & delight

These ride alongside the platform. They must obey **NS-3** (only good surprises — nothing that loses
state or confuses) and **NS-4** (no *needed* info lives in an overlay/toast). The buddy's messages and
timers are explicitly **decorative/encouragement**, never load-bearing — that's what keeps them NS-4-safe.

## EGG-0 — 💡 Slash-command framework (P2, enabler)

A small registry so `/buddy`, `/timer`, and future eggs are one-liners to add. Type `/x` → command fires.
Decide scope: portal-wide vs. editor-only. Keep it from colliding with real text entry (e.g. only at
line start, or a dedicated trigger).

## EGG-1 — 💡 `/buddy` — a pixel creature companion (P2) · the big delight piece

A little pixelated creature lives in the **bottom-right** of the screen.

- **Happy/excited + jumps up and down while you're typing.**
- **Falls asleep** if you don't type for a while (idle timer).
- **Wanders** the bottom of the screen sometimes, curiously.
- **Occasionally pops a pixel-font text box** with encouragement: "you got this!", etc.
- Implementation notes: `position: fixed` bottom-right so it **never causes layout shift** (NS-7);
  a pixel webfont for the speech boxes; sprite states {typing/idle/sleeping/wandering/talking};
  drive "typing" off editor input events. Respect `prefers-reduced-motion`. Make it dismissible.

## EGG-2 — 💡 `/timer` — set a timer (P2)

`/timer 25` etc. (writing sprints / Pomodoro). Surface time remaining in the real UI, not only a toast
(NS-4). Pairs naturally with the buddy (cheer at the end). Leave room for more eggs under EGG-0.

---

## Open questions / decisions to make

1. ~~Substrate~~ **Decided (DOCS-0):** the word processor is its own markdown-native build, fully
   separate from the HTML-dashboards feature. No longer blocking.
2. **"Anyone with the link can view"** — design the public view-token without widening write access on
   the student-visible student-hubs key (DOCS-2). Security-sensitive.
3. **Editor identity for counselors** — stamp Aaron/Ryan revisions and reuse `lib/identity.js` (DOCS-2a).
4. **Markdown rendering for the word processor's own readers** — student/parent/dev views render the
   stored markdown; markdown→HTML at read time vs. a rendered cache (DOCS-7a). Separate from the HTML
   feature's readers.
5. **Dark + neumorphic** — does NS-10 survive a dark palette, or do we relax neumorphism in dark mode?
6. **Scope creep vs. cutover** — none of this gates the 6/15 cutover; confirm the post-cutover order.

## Rough sequencing (once DOCS-0 is decided)

1. ~~DOCS-0 decision~~ — done; the word processor is its own markdown build.
2. DOCS-7 — port the Helthy markdown editor core (the foundation everything else sits on).
3. DOCS-2 / DOCS-2a — sharing model + WHO-edited version history (its own revision store).
4. DOCS-8 / DOCS-9 — invisible styling + clean export (the credibility pair).
5. DOCS-3 / DOCS-4 — tabs + command palette.
6. DOCS-6 — real dark mode.
7. EGG-0 → EGG-1 / EGG-2 — delight, last.

## Sources & references

- **Editor core (canonical, source of truth):** `Claude/Utils/md-editor/` — `md-editor.js`
  (`window.MarkdownEditor = makeEditor`), `md-editor.css` (themeable via `--mde-*`), `sync.sh` +
  `targets.json`, `README.md` (full API + `%%…%%` + theming docs). Extracted from the Helthy editor
  (`Helthy-HQ/Helthy_Dashboard.html`), which is now a *consumer*, not the source. Editor changes go
  here first, then `bash sync.sh` (project `CLAUDE.md` rule).
- Existing branch stack: `lib/supabase.js`, `lib/editableDocs.js`, `app/api/files/editable/route.js`,
  `lib/htmlSanitize.js`, `lib/studentFiles.js`, `lib/identity.js`, `app/edit/`.
- Design law: `northstar.md` (NS-1…NS-10). Program/data model: `senior_tab.md`. Storage:
  `supabase-migration.md`.
- Reference screenshots (Aaron, 2026-06-15): Google Docs **tabs** sidebar (Harvard/Princeton/Yale);
  Google Docs **`Option+/`** menu search ("poppins" → Poppins).
