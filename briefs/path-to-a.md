# Path to A — active roadmap

**Date:** 2026-08-07
**Status:** living document — check this first at the start of each session, update it
before ending one.
**Origin:** rated Caye's current state C+ after shipping
[workspace-events-plan.md](workspace-events-plan.md) Phases 0–3 and
[cold-start-plan.md](cold-start-plan.md) Phase 1 in one session. This is the punch list
from C+ toward A.

**Not autonomous.** Per the operating notes one level up (`/Products/Caye/../CLAUDE.md`):
*"Never autonomous. Act on commands, not initiative."* This file is the plan we work
through together, session by session, whenever you say go — not a background agent
grinding unattended for two days. Update the checkboxes as items land; that's what makes
the next session's "what's next" free instead of a re-derivation.

---

## 0. Not code — do this first, independent of everything below

- [ ] **Call Karenda about Jeff A Montenaro (complaint, held 14 days) and Sue Guilbert
      (policy hold, 13 days).** Both are real, both are visible now (the queue/hold fix
      surfaced them from underneath 17 outreach drafts), neither is fixed by anything on
      this list. This is the single highest-priority item in this file and it isn't
      mine to do.

---

## 1. Correctness foundation — do before anything downstream trusts the data

- [ ] **`booking_status` has no `completed` value** (`pending | confirmed | cancelled`
      only — confirmed via `pg_enum` 2026-08-07). A booking cannot complete. Outcome
      capture (below) and any reply→conversion metric are blocked on this. Needs an enum
      migration, then a decision on what flips a booking to completed (see next item).
- [ ] **Outcome capture — did the tour actually happen?** 79 inbound emails vs 6
      bookings logged in 30 days at Bimini; 612 bookings sit in `confirmed` forever, none
      ever reach a terminal state. The six-month-framing conversation's own answer:
      one daily closed question to the owner ("Both Tuesday tours ran — anyone not
      show?"), not open-ended data entry. Depends on the enum fix above.
- [ ] **`bookings.source` backfill is 611/621 `unknown`.** Not wrong to leave as
      `unknown` (that's the honest state per `20260807c`'s own design) — but
      `business-insights` needs to say so out loud the same way `workspace-feed.ts`'s
      `coverage` object does, rather than silently averaging known-source and
      unknown-source bookings together.
- [ ] **Audit other founder-dashboard routes for the command-overview/conversations
      drift pattern.** We found and fixed two routes with independently-drifted "needs
      review" logic by accident, from a user noticing two numbers disagree. We have not
      checked whether `app/api/founder/**` has other routes carrying similarly stale,
      duplicated business logic. Worth a deliberate pass, not another accidental find.

## 2. workspace-events-plan.md Phase 4 — the actual proactive layer

Everything shipped so far is read-layer: Caye is more honest when asked. She still
won't tell you anything unprompted. This is the gap between "accurate" and "an employee
who tells you things" — arguably the single highest-leverage item on this whole list.

- [ ] Per-person delivery cursors + explicit-action-only clearing (decision 10/11 in
      the workspace-events brief).
- [ ] Per-person quiet hours / digest time on `operator_allowlist` (decision 9).
- [ ] Daily digest + hardcoded interrupt allowlist, weekly heartbeat floor (decisions
      6–7).
- [ ] Per-person attention budget enforced in code (decision 4) — this is also the
      prerequisite that makes cold-start's "separate onboarding budget, exempt from the
      steady-state cap" (cold-start decision 3) mean something real instead of being
      trivially true because no cap exists yet.

## 3. cold-start-plan.md Phases 2–3

- [ ] **Phase 2 — archive-mining extraction pass.** Can be dry-run read-only against
      Bimini's 385-thread archive *without* shipping any confirmation to Karenda —
      decision 4 gates *shipping* to Bimini, not *analyzing* her data offline. That's a
      safe way to validate extraction quality before a real signup exists to test
      against live.
- [ ] **Phase 3 — staged usability in the reply pipeline + onboarding batch delivery.**
      Flagged in the brief as the one piece that touches `lib/caye-reply.ts` directly —
      give it its own review pass, don't ride it in on another phase's commit.
- [ ] No new signup exists yet (decision 4's rollout order has nothing to run against
      except Bimini, who's deliberately gated). Revisit this section's priority the
      moment one signs up.

## 4. The bigger open problem — Bimini's channel coverage

Not a two-day fix, probably not code-only. Bimini is email-only; WhatsApp is
structurally blocked because Karenda's business number is her personal phone. Every
number in every fix this session is a number about the minority of the business Caye
can see. Worth its own scoping conversation rather than folding into this list as a
task — flagged here so it doesn't fall off the map.

## 5. Business insights — re-enable once 1 and 3 are real

`business_insights` runs today over data that can't distinguish a Caye-made booking
from a phone-call booking, and over bookings that can never show as completed. Revisit
once outcome capture and source attribution exist — otherwise it's generating
confident analysis over the same unreliable substrate flagged back in the original
"is Caye the best AI employee" conversation.

---

## Also stale, not touched today

`STATE.md` (last updated 2026-06-01) and `BACKLOG.md` (2026-05-26) predate most of what
this session shipped and describe an earlier product shape (STATE.md still says "Zoho
Calendar is canonical," which the `bookings.source` work already complicates). Worth a
refresh pass at some point — not folded into this file because that's a different kind
of work (reconciling two months of drift) than the active punch list above.
