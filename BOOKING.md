# BOOKING.md — how a student gets meetings, and how to give them more

**Description:** the map of the portal's booking tracks and THE recipe for the ask that keeps
recurring — "⟨student⟩ needs a weekly ⟨N⟩-min ⟨topic⟩ with ⟨teacher⟩." Written 2026-08-17 after an
audit of every such ask since the track was born (8 sessions, 6/29 → 8/17; report + raw data in
`VS Code/scratchpads/student-portal/booking-profile-audit/`). Audience: Aaron and any Claude
working in this repo, including Sonnet.

## The recipe (start here)

**Task:** to give a student named weekly sessions, run — from the repo root —

```bash
node scripts/sessions.mjs set "Stacy Lim" "aaron/30/EAP English" "ryan/30/Microbusiness Incubator"           # dry run: prints the plan
node scripts/sessions.mjs set "Stacy Lim" "aaron/30/EAP English" "ryan/30/Microbusiness Incubator" --commit --notify
```

**Description:** `set` is declarative — after it, the student's ACTIVE weekly sessions are exactly
the specs given (matches kept — with label casing and the plan's login email repaired to what the
roster says — missing ones created, the rest ended with a dated note; running it twice is a no-op). `--notify` emails the student (CC parents) one booking link per NEW session.
`add` and `end` are the incremental forms; `show "<student>"` prints the student's whole booking
picture across every track; `list` prints all active weekly sessions. `--help` prints the full usage.
**Description — a spec:** `teacher/minutes/label`. Teacher ∈ aaron, ryan. Minutes ∈ 15/20/30/45/60.
Label = what the student SEES — the card title on the Meetings tab, the default calendar title
("Stacy Lim – 30min: EAP English"), the description's Agenda line, and the email button ("Book your
EAP English"). No code change, no SQL, no Clerk session — the student's next load of `/meetings`
shows one card per session under "Your weekly sessions".
**Rule:** the student must already have a Master-sheet row (👩‍🎓 All Data) with a portal sheet
URL (col G); the login email (col J) is what the booking gate authorizes on — the script warns
and proceeds without one, but the card 403s until col J is filled. `<student>` is a name substring or an email; ambiguity is
refused with the candidates listed. Not on the roster yet: pass `--sheet-id … --email … --name …`.
**Rule:** the rules the script enforces (teachers, lengths, label may not contain "parent",
duplicate = same teacher+length+label) live in ONE place, `lib/sessionSpec.js`, shared with the
admin route `app/api/admin/grantProjectMeeting` and the developer panel form. Change them there.
**Provenance:** verified 2026-08-17 — `scripts/verifySessionsCli.mjs` (43 live assertions on a
synthetic student, self-cleaning) and dry runs against Olivia Lim's real rows.
**Pointer:** the same thing by hand in the browser: `/developer/students/<sheetId>` → "Set up a
weekly project meeting" (one session per submit).

## The four tracks — which one an ask belongs to

**Description:** a student can hold any combination; each track has its own entitlement, its own
ledger, and its own card(s) on `/meetings`. `scripts/sessions.mjs show` prints all four.

| Track | What it is | Entitlement lives in | Gate | Give one via |
|---|---|---|---|---|
| **Weekly sessions** ("project meeting" in code) | Standing, named, 1-per-Saturday-week meeting with a fixed teacher + length; rolling two-week horizon; no check-in needed. Solo research, SAT/ACT tutoring, competitions, counseling, "weekly meeting" — any recurring 1:1. | Supabase `project_meeting_plans` (+ ledger `project_meeting_bookings`) | none | `scripts/sessions.mjs` ← **this is the answer to almost every "give X a weekly …" ask** |
| **Check-in tokens** | Weekly check-in form → Claude/Ryan grants a 15/30-min token with Ryan (Master AZ) or Aaron (Master BB); ART students also get a weekly ART token (BD). | Master sheet cells | weekly check-in | the check-in flow itself; a one-off bypass token: `/api/admin/grantBooking` (developer panel) |
| **Senior essay cadence** | Class-of-'27 essay program: package (essential/comprehensive/vip) → N meetings/week with the primary teacher + a monthly cross-meeting; deterministic, ledgered. | Supabase `seniors` + `senior_checkin_grants`/`senior_bookings` | senior check-in | `seniors` row (ingest script); one-off extras: `senior_oneoff_grants` via the developer panel's "Grant" form (`/api/admin/grantBooking`) |
| **ART (group)** | Advanced Research Team weekly 15-min with Aaron, timestamp token. | Master BC (flag) + BD (token) | weekly | flip Master BC |

**Rule:** a "weekly ⟨topic⟩ with ⟨teacher⟩" ask is a weekly session, even for a senior — it is
additive to their essay cadence and charged to its own ledger (deep link `?m=project:<planId>`),
so it never spends essay tokens. Never model it as extra senior tokens.
**Rule:** a ONE-TIME makeup / extra meeting is never a plan. The developer panel's "Grant" form
(`/api/admin/grantBooking`) does the right thing by itself: a senior gets a `senior_oneoff_grants`
row, anyone else gets a Master AZ/BB token.
**Pointer:** `supabase/project_meetings.sql` (the plan model + why it exists), `lib/projectMeetingsCore.js`
(the pure rules: horizon, 1/week cap, card), `lib/projectMeetings.js` (IO), `app/(portal)/meetings/page.js`
(`ProjectSection` renders the cards), `app/api/bookMeeting/route.js` (the booking gate + title default).

## What the model can and cannot express (so you don't hand-hack around it)

**Description — expressible with the CLI, no code:** any number of sessions per student; two
sessions with the same teacher (they get distinct labels and never consume each other's week);
lengths 15/20/30/45/60; a package "shift" (`set` with the new list — old plans stay as inactive
rows with the supersede note, already-booked meetings stay on the calendar).
**Description — NOT expressible today, and the honest workaround:**
- **A teacher other than Aaron or Ryan** (e.g. an outside ACT-math tutor): the portal can't book
  them (no calendar/hours in `lib/instructors.js`). Leave them out; name them in `--note`.
- **A cadence other than 1 per Saturday-week** (2/week, biweekly, a fixed weekday): the cap is a DB
  unique index per plan+week. Two per week = two differently-labelled plans (honest, and the
  student sees two cards). Biweekly / fixed weekday: not modelled — say so rather than approximate.
- **A start/end date** ("5 weeks from 8/10"): plans are open-ended; put the horizon in `--note` and
  `end` it when it's over. (An `ends_on` column would be the additive fix if this recurs.)
- **A check-in-gated weekly session:** the track is deliberately un-gated. If Aaron wants one gated,
  that's a check-in token, not a plan.
**Risk:** two identical active plans silently double the student's weekly cap (the cap is per
plan). The CLI and the admin route refuse the duplicate unless told `--allow-duplicate` /
`allowDuplicate:true`; the DB-level index that would make it impossible is written but NOT applied
(`supabase/project_meetings_v2.sql`) because one live student already holds such a pair — see
"⛔ Open" below.
**Risk:** a plan whose `student_email` doesn't match the student's Clerk login renders a card that
403s on booking (the card is keyed by sheet id, the gate by email). `sessions.mjs` takes the email
from Master col J and warns when it's blank.

## Decisions on record

**Status (2026-08-17 · Aaron):** Vaibhav Gaddam's two identical active `aaron/30/Solo Research`
plans stay as they are for now (he can book twice a week). Consequence: the unique index in
`supabase/project_meetings_v2.sql` stays UNAPPLIED; the duplicate guard is code-level only (CLI +
admin route). If that ever changes: `node scripts/sessions.mjs end "Vaibhav" e0e44906 --commit`,
then apply the index.
**Status:** the CLI, shared validator, admin-route duplicate guard, and the admin-reschedule
ledger sync (+ its 1/week pre-flight, which refuses the move before the calendar is touched) are
in the repo as of 2026-08-17; deploy status is in the commit that carries them
(main auto-deploys to prod).
