# Portal Redesign — North Star

The canonical design principles for the `redesign` branch. When a design decision is
ambiguous, this file wins. Cite a rule by its ID (e.g. "NS-3") in PRs, commits, and review.

These supersede the scattered statements that previously lived only in local memory
(`info-once-northstar`, `loading-layout-stability-northstar`). Keep this file as the single
source of truth; update it here when a principle changes, then mirror the gist back to memory.

---

## Information architecture

### NS-1 — Show each piece of information exactly once, in its perfect place
*"Only show each piece of information once… and make sure it's in the perfect place."* (Aaron, 2026-06-09)

Detail and interaction live in exactly ONE tab/subtab (e.g. cancel/reschedule only in
Meetings ▸ Upcoming). Home may carry compact **pointers** that deep-link to that one place —
never a second copy of the data.

- **Pointers, not duplicates.** A Home pointer renders ONLY when actionable; never render an
  empty-state card ("No meetings booked") that burns prime real estate.
- **Prefer a visualization over a text container** for at-a-glance state (e.g. Home Halo rings).
- **Why:** the first redesign pass showed meetings in 3 places and check-in status in 3 places —
  noise that erodes trust in what's authoritative.

### NS-2 — Cardinal icon rule: one icon, one destination
No two identical icons may lead to different navigational targets — across the dock AND the
per-tab dials. Same icon → same destination is good wayfinding; the reverse is a "cardinal UI
sin." Two calendar icons pointing at different routes is exactly the failure this rule forbids.

---

## Surprise & trust

### NS-3 — The only surprises should be good surprises
The app should be predictable by default. Delight is welcome; confusion, lost state, and
unexpected destinations are not. If a behavior could make the user think *"wait, what just
happened?"* in a bad way, it's a bug — even if it "works."

### NS-4 — Never put information in a pop-up or splash screen
This is a **failure mode, not a nudge.** Assume every user closes or skips overlays *without
reading a word*. Any information the user actually needs must live in the real UI, where it
persists and can be returned to.

- **Splash is a load cover, not a message.** A splash before Home (the "Back at it, Aaron"
  style) is allowed ONLY to cover measure-and-hydrate while cached data loads (see NS-7). It
  must never carry text the user is expected to read, and must never gate access to content.
- Corollary: no onboarding tours, no "did you know?" toasts that hold real info, no
  read-this-first interstitials.

### NS-5 — Avoid modals; when one is unavoidable, make it free to leave
Avoid modals whenever possible. When a modal is genuinely required:

- The user **MUST** be able to "X" out of it, and doing so returns state to exactly what it was
  before the modal opened — **no side effects from dismissal.**
- **Never** require a user to navigate or complete a modal to resume primary app functionality.
  A modal may never be the only door back to the core app.

---

## Performance & stability

### NS-6 — Every millisecond of load lag counts
Reduce drag everywhere; optimize network performance aggressively. The current build's worst
flaw is blank → spinner → content jank from client-side Google Sheets fetches. Build
local-first / stale-while-revalidate: hydrate from cache first, revalidate in the background.

### NS-7 — Zero layout shift: no moving UI on load-in
The app measures the screen, picks a stable position (or a fixed animation track, e.g. a
sidebar swipe), and never lets load-in reflow stable/canonical items.

- No SSID-list-style pop-in-and-reorder. No time-sensitive CTA squeezing stable elements.
- Time-boxed/promo items (e.g. "register for SAT summer class") may ONLY fill **pre-allocated
  canonical whitespace.**
- Reserve exact dimensions with skeletons; first paint of Home is already the final layout, then
  revalidate in place without reflow.
- **Goal:** once you know the layout, you can navigate the whole app **eyes-closed.** Full stop.

---

## Personalization

### NS-8 — Leverage what we know for deep personalization
ChatGPT proved that a flashy interface loses to cutting-edge, deep personalization and user
insight. We hold rich per-student data (scores, projects, college list, timeline, history) — use
it. The win is an experience that feels like it knows this specific student, not a prettier shell
around generic content. Personalization beats polish.

---

## Interaction cost

### NS-9 — Every tap and click matters
Interaction cost is a first-class budget. Collapse steps, remove confirmations that don't protect
anything, default the obvious choice, and put the most common action within one reach. A feature
that's correct but takes one tap too many is not done.

---

## Visual language

### NS-10 — Confidently neumorphic, distinctly premium
Rounded, organic icons; muted palette; only 1–2 elements onscreen carrying the hero/CTA color at
a time. **Prefer icons to text for navigation.** The Colleges tab is the reference implementation
of this language (see `senior_tab.md`).
