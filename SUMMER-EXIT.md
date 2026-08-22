# Exiting summer phase — work map

**Status:** open. Created 2026-08-18. Companion to `BOOKING.md` (which maps the four booking tracks).

**How to read this file.** There are no phases and no step numbers, deliberately — ordering is *derived* from the
dependency lines, not asserted. Every item is tagged `DECIDED` (Aaron's call, do not re-litigate; push back only
with new evidence) or `INFERRED` (Claude's reasoning, challengeable — argue with it freely). If you are a fresh
session about to explain why the ordering is wrong: the ordering is whatever the `Requires:` lines imply, so
argue with an edge, not with a sequence.

---

## The clock — things that come due on their own

These are not tasks anyone can finish early. They fire by date whether or not the work below is done.

**2026-09-01 · auto-expires, no action required.** `isSummer()` is `month >= 6 && month <= 8` in
`app/(portal)/check-ins/RyanCheckIn.js:44` and `app/(portal)/check-ins/SeniorCheckIn.js:32`. On Sept 1 the
grades/transcript step reappears in both check-in forms by itself.
→ `INFERRED` action: confirm on 9/1 that the returning step still asks for the right thing. Nobody has looked
at that copy since June.

**2026-09-01 · auto-expires, no action required.** `Google Apps Scripts/checkin-reminder/checkinReminder.gs:19-21`
carries an explicit "☀️ SUMMER EXCEPTION (6/1–8/31)" that changes what counts as *engaged* for the nudge email.
The definition silently changes on 9/1.

**RESOLVED 2026-08-19 (commit `2f4aefc`, deployed).** The triage path's season context is now computed from
the same June–August LA window as `isSummer()`, and `'pending'` is unreachable — see W1/W2/W3/W6 below.

---

## Open decision — everything below hangs on this

**D1 · RESOLVED — `DECIDED · Aaron 2026-08-19`: Option A, the evaluator grants directly.**
Claude recommended Option B and Aaron chose A; do not re-litigate. Unblocks W1, W2, W3, W6. **Dissolves W7**
(nothing queues for a human under A). **Makes W3 mandatory rather than optional** — see the ⚠ under it.
**What A means operationally:** the AI grants directly — no email to Ryan, no approval click, no `'pending'`.
The entitlement itself (a student may book) and the cancel/restore behaviour stay.

⚠ **Clarified by Aaron 2026-08-19, immediately after the ruling — do not read A as endorsing the spreadsheet.**
His words: *"the whole point of the cutover is that a booking outcome should never live in the master sheet,
buried somewhere in column AW or something ridiculous like that."* D1 decided **WHO grants** (the evaluator, not
a human). It decided nothing about **WHERE the grant lives**, and the answer there is the database, not master
AZ/BB. Claude's original framing of A as "keeps the token machinery, keeps the cell" conflated the two and was
wrong on the second half.

→ The destination already exists and is already being fed: `booking_tokens` (`student_sheet_id`, `instructor`,
`token_value`, `granted_at`, `consumed`) — 28 rows across 28 students, last written 2026-08-19. Today it is a
best-effort MIRROR while Sheets stays authoritative (`lib/bookingTokens.js`). Making it the source of truth is a
read-flip plus dropping the sheet write, not a build. It should also gain `student_id uuid` for consistency with
the native key added the same day.

**Measured 2026-08-19, the state A is preserving:** AZ holds `no`×22, blank×13, `written`×10, `15min`/`30min`×2.
BB holds blank×30, `no`×11, `email`×4, `30min`×2. So **2 of 47 students can book Ryan and 2 of 47 can book Aaron
at any given moment.** Volume for context: ~92–103 meetings/month Feb–Apr across 47 students; busiest single
student 19 meetings in 90 days.

**The original question, for the record:**
When a check-in decides a student needs time, what happens?

- **Option A — the evaluator grants directly.** The AI writes `'15min'`/`'30min'` straight to AZ, no human step.
  Smallest diff. Keeps the gate, keeps the token machinery, keeps the cancel/restore dance.
- **Option B — remove the gate entirely.** `INFERRED, Claude` — students book freely; the check-in becomes
  meeting *prep* attached to an already-booked meeting ("You're on for Thursday. What should Ryan look at?").
  Deletes the eligibility computation, the bypass subset, the token restore-on-cancel logic, and the modal.
  Engagement enforcement moves to the instrument built for it: the compliance dashboard and the Friday nudge.
  A nag is the right tool for engagement; a lock never was.

`DECIDED · Aaron 2026-08-18`: whatever is chosen, **no booking path may wait on a human clicking something.**
See the ⛔ section in `.claude/CLAUDE.md`.

---

## Work items

**W1 · Remove `'pending'` as a reachable outcome.** `DONE 2026-08-19` · commit `2f4aefc`, verified deployed
(prod alias serves the new deployment; retired routes 404).
The evaluator grants directly: `meeting: true` → it writes the `15min`/`30min` token itself and emails the
student + parents the booking link (`sendMeetingGrantedEmail` — same email the approval flow sent). Season
context is computed (June–Aug LA), grade drops now reach the prompt, and AY stamps only AFTER the decision
write lands (so a failed write can't show "you're checked in" over a missing token).

**W2 · Delete the orphaned triage machinery.** `DONE 2026-08-19` · commit `2f4aefc`.
Deleted: `app/api/checkinDecision/`, `app/checkin-approval/`, `lib/checkinApproval.js`,
`sendRyanMeetingRequestEmail`, the signed-token minting, `scripts/stressTestRyanCheckin.mjs`, the two
proxy.js public routes, `instructors.masterColumn` — plus `app/api/devSetBookingToken/` (adversarial review
finding: it was an ungated self-service 30-min-grant backdoor that defeated W3). Repo swept clean of references.

**W3 · Close the server-side authorization gap.** `DONE 2026-08-19` · commit `2f4aefc`.
`bookMeeting` now reads the token server-side for standard/ART before creating the event (verified reschedules
exempt; consume keyed on the verified `replacingEventId`, not the client flag). Pre-ship enumeration of BOTH
calendars found exactly ONE upcoming standard-track booking (token properly consumed) and ZERO ungated
bookings — nobody stranded. Partial-enforcement residue is W18. Original analysis kept below for the record.
**Requires: D1 — now RESOLVED, so this is live work, not a maybe.**
⚠ **Under Option A the gate is retained, therefore the gate must actually be enforced — and today it is not.**
Re-read of `app/api/bookMeeting/route.js` (434 lines) confirms: the project track authorizes via
`canBookProjectOnDate` and the senior track via `canBookOnDate`, but a **standard (Ryan/Aaron) or ART** booking
— `senior` null, no `projectPlanId` — never reads AZ/BB before creating the calendar event. `validateBooking`
is a separate endpoint the client calls, so a direct POST books with no token check. Net effect today: the gate
that locks out 45 of 47 students is client-side only.
→ Fixing it will start REJECTING bookings that currently succeed, so it is a behaviour change with a
user-visible failure mode, not a silent patch. Enumerate who is currently bookable-in-practice before shipping.

⚠ **Naming trap that cost a wrong query on 2026-08-19 — read this before enumerating.** The Supabase `meetings`
table is **NOT** the booking table. Its columns are `teacher · project · agenda · homework · hw_status · pct` —
it is the sheet's 📆 Meetings **log** (what was discussed, what was assigned), 1,360 rows of history. Querying it
for "upcoming bookings" returns one stale STEM 1:1 row and looks like the blast radius is zero. It isn't.

**Where bookings actually live, per track:**
- **project** → `project_meeting_bookings` (6 upcoming as of 2026-08-19)
- **senior** → `senior_bookings` (11 upcoming)
- **standard (Ryan/Aaron) and ART** → **nowhere in Postgres.** A Google Calendar event plus the master AZ/BB
  cell IS the entire state. This is precisely the track with the unenforced gate.

→ So the pre-ship enumeration is: **read the Ryan and Aaron Google Calendars for upcoming events and cross them
against AZ/BB**, looking for anyone holding a future standard-track meeting with no token — i.e. someone who
booked through the ungated path and would be affected by closing it. Calendar ids are in `.env.local`
(`GOOGLE_CALENDAR_ID_AARON` / `GOOGLE_CALENDAR_ID_RYAN`). Cannot be answered from the database alone.
`app/api/bookMeeting/route.js` gates only the senior and project tracks. For standard and ART it never reads
AZ/BB — a direct POST books with no token check. `validateBooking` holds the only check and nothing enforces it.
→ If D1 resolves to Option B this item **dissolves** rather than being done: there is no entitlement left to enforce.

**W4 · Collapse the week calculator.** `INFERRED` · Owner: Claude · **Requires: nothing.** Can start today.
`startOfSaturdayWeek` exists byte-identically in three places: `lib/seniorsCore.js:27`,
`app/(portal)/portalUtils.js:19`, `app/api/validateBooking/route.js:29`. One home, imported everywhere.

**W5 · Reconcile — or deliberately document — the two definitions of "week."** `INFERRED` · Owner: Aaron decides,
Claude implements · **Requires: nothing.**
The booking gate is Saturday-00:00-LA anchored. The compliance dashboard
(`app/api/developer/checkinCompliance/route.js:22`) and the reminder script (`checkinReminder.gs:71`) use a
**rolling 7 days**. These may legitimately differ — a nag window and an entitlement window are different objects —
so the deliverable may be a comment, not a fix. What is not acceptable is that the divergence is currently undocumented.

**W6 · Full Supabase cutover for the standard track.** `DONE 2026-08-19` · commit `2f4aefc`.
`booking_tokens` is the AUTHORITY for ryan/aaron/art: every write site and every reader goes through
`lib/bookingTokens.js` (`setBookingToken`/`getBookingToken`/`getBookingTokens`); the Master AZ/BB/BD cells are
dead (residue only). `student_id uuid` added + backfilled 28/28. Pre-flip parity: 28/28 cells, 0 mismatch.
NAS reconcile cron redeployed WITHOUT the booking_tokens step (mirroring from dead cells would prune real
grants — instructor_blocks precedent); orphaned `backfillBookingTokens.cjs` rm'd on the NAS and the repo copy
refuses to run. `shadowCompareBookingTokens.cjs` is retired with it (its sheet side is now dead) — deletable.

**W7 · Admin visibility for any surviving human-gated state.** `DISSOLVED 2026-08-19` by D1=Option A —
the evaluator grants directly, so no state queues for a human and there is nothing to make visible. Original text:
Only applies if D1 resolves to something that can still queue. The 2026-08-18 incident happened because the queue
existed only inside an inbox and nothing enumerated it. → **Dissolves** under Option B.

**W8 · Calendar account migration.** `DECIDED · Aaron` · Owner: Aaron (needs account access) · **Requires: nothing.**
`ryansapientchoice` → `ryan@ryanchoice.com`; `aaronblumenthal21@gmail.com` → `aaron@sapientacademy.com`.
Independent of every item above. Blast radius is every existing calendar event's owner and every booking that
writes to a calendar — scope this before touching it.

**W9 · Move the Sapient Public Database into Supabase.** `DECIDED · Aaron 2026-08-19` · Owner: Claude ·
**Requires: nothing.** Independent of D1 and of every item above; it is here so it is not forgotten, not
because it blocks anything.
`https://docs.google.com/spreadsheets/d/11wfnN293v-vgmkBVboqwpt5mg3dUq-_ZothceeRBtdc/`
Aaron's reason, his words: *"otherwise, a bunch of JOINs/VLOOKUPs will break."*

**What it actually is** (verified 2026-08-19, portal service account, read-only). Three flat reference tables —
**not** student data, and far smaller than the grid dimensions suggest (`College List` allocates 50,508 rows and
uses 161):
- `College List` `gid=1224488097` — **160 colleges**, cols B–L: `CEEB · College · EA · ED1 · ED2 · RD · REA ·
  Special · Special Note · Platform · Supplements`.
- `Competitions` `gid=1767680903` — **51 competitions**: `Competition · Category · Deadline · Length ·
  Difficulty · Eligibility · Region · Registration · # Recognized · Template · Other Info`.
- `Summer Camps` `gid=1418616885` — **57 programs**: `Camp · Category · Deadline · Eligibility · Rolling ·
  Prereqs · Template · Essays · Letter of Rec · Transcript · SAT/ACT · Cost`.

**Traps, all verified in the live cells:** every tab parks a **side info panel** to the right of its table
(`# of colleges` = 160, `# of Comps:` = 51, `# of Programs:` = 57, plus an EA/ED guide and a difficulty
disclaimer) — those are not columns, and whole-row inserts/deletes wreck them. Deadline cells are **serial
numbers** (`45231`, `46061`), so the `Math.round((raw - 25569) * 86400 * 1000)` UTC idiom in `.claude/CLAUDE.md`
applies; other deadline cells in the same column are strings (`Rolling`, `unlisted`, `N/A`). The CEEB column
carries **magic strings** — `UC` / `CSU` are aggregate rows, not missing values. Known duplicate rows exist
(UIUC twice under CEEB 1836; Indiana University twice); dedupe is a Ryan decision, not a migration detail.
Prior art with the writer rules already worked out: `scratchpads/AP-Counseling/write_phase_plan.json` (2026-07-16).

**Also verified: nothing in code reads this file.** The spreadsheet ID appears in no project's source — the only
hits across all of `VS Code/` are two Claude-transcript archives and that AP-Counseling scratchpad. So the
consumers are spreadsheet *formulas* (student sheets, Master), not app routes. Do not go looking for a `lib/`
module to port; there isn't one.
→ **Partly measured 2026-08-19** (six sheets sampled, not all 47): consumers appear to be effectively zero — five of six student sheets carry no formula referencing `Database!` at all. Detail, the two IMPORTRANGE variants found, and the tab-name-vs-*table*-name trap: [`_notes/reference-data-model.md`](_notes/reference-data-model.md). Still unchecked: Isaac Lee's one reference, and Master.
→ `INFERRED` first move, before any data is copied: **enumerate the consumers.** The set that VLOOKUPs into this
file is invisible from the repo and unrecoverable after the fact — a migration that lands before that list exists
breaks formulas nobody can name. Every consumer still has to read *something* afterward, and whether that is a
mirrored sheet tab, an API-fed range, or a rewritten formula is an open decision, not a detail.

**W10 · Model the reference data from the capabilities, not from the spreadsheet.** `DECIDED · Aaron 2026-08-19` ·
Owner: Claude · **Requires: nothing.** Supersedes the framing of W9, not its content — W9 still describes the
source file correctly; W10 says the destination is a domain model rather than a copy.
Full model, measurements, and open question: [`_notes/reference-data-model.md`](_notes/reference-data-model.md).

Aaron's reason, his words: *"the pathing/JOINs/whatever become stupid-simple from a database perspective once you
think of it that way, instead of 'crap, I need to normalize and transfer 47 different google sheets paradigms to a
new surface.'"*

**The two capabilities the model is derived from:** (1) type-to-complete college pick → choose a round → see that
round's deadline immediately; (2) one competition/camp = one entity across students, so *"how's everyone doing with
John Locke?"* is answerable, and assigning one grants the student a template file in the markdown engine.

**Measured 2026-08-19, the evidence that a straight port is the wrong move:** `student_comps` is 1,409 rows of which
only **557 are real** (422 NULL, 411 empty, 19 named `concatenate`); `student_college_lists` is 35 opaque `jsonb`
blobs, not a list; and one program is already three strings (`John Locke '26 / '25 / '24`, 8 students) because the
cycle is glued into the name.

→ **Blocks the URL scheme.** All 40 `student-hubs` tables key on `student_sheet_id` — a Google Docs ID, and the one
identifier `proxy.js` names as unsafe to expose. `portal.admissions.partners/[student]/…` has no legal value for
its first slot until `students` gets a native `id uuid` + slug. File keys already exist (`md_tabs.id`).

→ **Open, and Aaron's to answer:** do the student sheets keep a mirrored copy of reference data at all, or does
lookup become portal-only?

**W11 · Native student key.** `DONE 2026-08-19` · `students.id uuid` + `students.slug`, 47/47 unique, slug matches
the omnibar's algorithm exactly so the portal URL and the omnibar address are one string. `student_sheet_id`
untouched. **Unblocks the `/[student]/…` URL scheme.**

**W12 · Reference seed.** `DONE 2026-08-19` · 160 colleges, 312 rounds, 107 programs, 107 cycles.
⚠ **Zero real cycle-2027 deadlines exist** — 185 of the dated rounds are cycle 2024. A college picker built on
this data today would show current applicants deadlines one to three years old. **Refreshing the source is a
prerequisite to the picker**, not a detail of it.

**W13 · Resolve selections.** `DONE 2026-08-19` · tabs→college 275/287, college-list blobs→`student_colleges`
305/308, comps→`student_programs` 165/557. Unresolved rows keep `raw_name` with a null FK — the review queue is
the data, nothing guessed, nothing dropped. The 30% comp rate is a **catalog-coverage finding**: AP's own services
(ART, English 1:1s, SAT) and real-but-missing programs (Congressional Award ×12, YYGS ×6, SIMR ×4) are not in the
public DB at all. Both target queries now work.

**W14 · Consumer sweep.** `DONE 2026-08-19` · **closes W9's open question.** Student sheets consume the imported
reference data **zero** times — Isaac Lee's lone `Database!` formula is a VLOOKUP into a 5-row local grade helper
at AS:AT, not the imported data. Master is the only real consumer (3 references, `Database 1` tab). Normalization
is deletion: drop the `Database` tab from the student template. One sheet to handle, not 47.

**W15 · College picker UI.** `not started` · **Requires: W12 refresh.** Smallest surface that proves the model
end to end. No typeahead/combobox exists anywhere in the codebase yet; the write pattern to copy is
`BookingFlow.js` + the check-in forms.

**W16 · Program view + cross-student query UI.** `not started` · **Requires: W15.**

**W17 · Read-flips, domain by domain.** `not started` · **Requires: W15/W16.** Each flip is a live behavior
change and needs Aaron's go/no-go; everything in W11–W14 was additive and needed none.

**W18 · Booking-gate residue (from the 2026-08-19 adversarial review).** `INFERRED` · Owner: Claude ·
**Requires: nothing.** Non-blocking follow-ups on W3/W6, listed so nobody believes the standard track is fully
server-authoritative: (a) the monthly Ryan cap (✅ Check-Ins H/I) is enforced only in `validateBooking` — a
direct POST books past it; (b) ART length isn't server-checked; (c) two concurrent POSTs can double-spend one
token (same race the sheet had); (d) `cancelMeeting` trusts the client's `duration` for the restore value and
doesn't verify event ownership; (e) the reschedule exemption verifies ownership, not booking type (documented
in the gate comment); (f) the senior email-vs-sheetId resolution asymmetry (pre-existing, documented in
`submitUpdateForm`).

**W19 · Meetings log goes portal-native (per-student booster).** `DECIDED · Aaron 2026-08-21` · **Requires: W11.**
First `/[student]/…` route shipped: `/[slug]/meetings`, staff-only, editable for students flagged
`students.meetings_source='portal'` (Isaac Lee first; his 📆 sheet tab is frozen, the cron skips his meetings). The
omnibar's dead "Meetings" tile and a typed `nm` verb deep-link into it. Details in `.claude/CLAUDE.md` → "Meetings LOG
goes portal-native". Found and fixed on the way: the mirror's prune read was capped at PostgREST's 1,000 rows on a
1,368-row table (under-pruned the tail for months; now paged).
→ `INFERRED` next: flip the rest of the roster once Aaron has lived in the page for a week; then the Terminal-Mode
`nm` inside a shelf (handoff: route model first); the scoreStudents/collegeList sheet readers switch to the table.

---

## Already done, 2026-08-18

Seven students were found stranded in `AZ='pending'` — checked in, told "Ryan is reviewing your check-in," with
no exit. Oldest: Riti Nalabolu, 60.8 days.

`DECIDED · Aaron`: no apology and no outreach — that manufactures seven complaints where none exist. Six stale
rows were set to `'no'`, which renders "Check in to unlock" and returns them silently to the normal weekly cycle.
Khushi Gehani (1.9 days, a live request rather than a casualty) was granted `'15min'`.

**Carry-forward:** the grant was a direct cell write, so it **skipped `sendMeetingGrantedEmail`** — Khushi and her
parents were never emailed the booking link. She will only discover the bookable card on her next portal visit.

Backup of the seven prior cell values (one-command undo):
`/Users/aaron/Documents/VS Code/scratchpads/portal-pending-drain-2026-08-18/AZ-backup.json`
