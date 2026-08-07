# Workspace event stream + proactive comms — plan

**Date:** 2026-08-07
**Status:** Phases 0 + 1 shipped to prod 2026-08-07. Phases 2–4 not started.

**Shipped:** `20260807c_bookings_source`, `20260807d_workspace_events`,
`20260807e_workspace_events_attribution_fix`, `20260807f_workspace_events_revoke_rpc`.
Backfill verified exact — 1614/1614 messages, 621/621 bookings, 2323 events, 6 cursors
for 6 operator rows all seeded to high-water 2323. Live trigger fire confirmed twice
(before and after the RPC revoke) and both test rows removed.
**Origin:** grilling session — "why doesn't Caye know what's going on with our businesses?"
**Related:** [cold-followup-plan.md](cold-followup-plan.md) — shares `guest_served` (Phase 2 there, Phase 3 here)

---

## 1. Diagnosis (verified against prod)

**The trigger.** 2026-08-07 03:38, TropiTech Outreach workspace (`7c0537ff`). Asked "who
was the last person to email me?", Caye answered: *"Nothing in the activity feed for the
past week either — no inbound messages or bookings logged. It's possible the email
channel isn't connected yet."*

Every part of that was wrong:

| Claim | Reality |
|---|---|
| "email channel isn't connected" | `connected_accounts` email row, `is_active = true` since 2026-07-23 |
| "no inbound messages" past week | 34 inbound customer messages in 14 days, 3 on 08-06 |
| — | Last emailer: Zanzibar Holidays One (`zanzi2go@gmail.com`), 08-06 06:12 UTC, *"Hello, How can we see it?"* — Caye replied to them herself 80 min later |

**Root cause is structural, not prompt.** `getActivitySince`
(`lib/caye-agent/activity-since.ts:126`) — the only thing behind `get_recent_activity` —
queries four things: bookings changed, holds opened/cleared, escalations, and customer
messages **only on already-held threads**. An ordinary inbound message on a non-held
thread produces zero events. Outreach replies never open holds, so that feed is
structurally empty forever.

No fallback tool exists. Every read tool touching `unified_messages` needs the customer
named (`get_customer`, `get_customer_history`), needs a search string
(`search_threads:47`), or filters to held-only (`get_held_queue`). `get_today_summary:81`
still carries `TODO(#40): replies_sent`. **A perfectly prompt-compliant Caye returns the
same wrong answer.** The only additional model error was volunteering the
"maybe email isn't connected" theory instead of calling `get_channel_status`, which
would have contradicted it.

`get_recent_activity` also computes `escalationEvents` and `chaseMessages` and then drops
both on the floor at `get-recent-activity.ts:37-51`.

**The deeper problem — Caye's senses end at the wire.**

Bimini (`653257d9`), last 30 days: **79 inbound guest emails, 125 replies out. Zero
Instagram. Zero Messenger.** Effectively an email-only business.

Bimini bookings, all time: **616 rows — 10 with `conversation_id`, 11 with an email, 6
created in the last 30 days.** So 79 people wrote in last month and 6 bookings were
logged. Either conversion is 7.6%, or bookings are taken by phone, by WhatsApp on
Karenda's personal handset, and at the dock, and never written back. `bookings` has **no
`source` column**, so Caye cannot distinguish the two.

WhatsApp is structurally blocked at Bimini — Karenda's business number is her personal
phone; Cloud API migration would kill WhatsApp on her handset.

**Operator landscape.**

| Phone | Workspaces | Role | Last inbound |
|---|---|---|---|
| `+13342219466` (Lamar) | **4** | founder + owner | 2026-08-07 |
| `+12424422629` (Mrs. Max / Karenda) | 1 | owner | 2026-08-07 |
| `+12424730233` (Max) | 1 | owner | **never** |

Lamar is the only person who experiences Caye as multi-workspace — four workspaces
through one WhatsApp thread. The locked budget of 3 msgs/day/**workspace** would put 12
a day into it.

Karenda recovered: Bimini week of 08-03 ran 77 out / 64 in, near 1:1. The July collapse
(122 out, 0 in) healed. Do not design as if she is still gone.

Max has never sent a single message. His number is corrected now, but the seat is dead.

---

## 2. Decisions locked this session

1. **One canonical `workspace_events` stream**, built in full now — not staged behind a
   read-path patch. Every question Caye answers about "what's happening" and every
   proactive message she sends reads from it.
2. **Trigger-derived by default.** Postgres triggers on `unified_messages`, `bookings`,
   `caye_escalations`, `connected_accounts`, and `unified_conversations`
   `human_agent_enabled` transitions. Zero app call sites. `origin` column tags
   `trigger` vs `app`; app-writes are the narrow exception for genuinely rowless events
   (cron failures, low-confidence non-replies). Migration lives in the repo, never
   applied ad hoc through MCP.
   *Rationale:* 22 files insert `unified_messages`, 6 insert `bookings`. This codebase's
   characteristic failure is the forgotten write path — `bookings.conversation_id` at
   10/616, `nudge-scan` built but never registered, Max's phone missing its country code.
   A partial event stream is more dangerous than none: Caye reports "nothing happened"
   with confidence, which is the bug we are fixing.
3. **Record everything, report selectively.** Full fidelity in the table; opinionated at
   the read layer. **Reportable = something the outside world did, OR something that was
   supposed to happen and didn't.** Silent-by-default = things Caye or an operator did
   successfully, on purpose — recorded, queryable on request, never volunteered.
   A cron that didn't run is the highest-priority event in the system: it means the
   stream itself is lying.
4. **Attention budget is per person, not per workspace.** Karenda: 3 interrupts/day.
   Lamar: one batched cross-workspace digest + hard-failure reserve. Cross-workspace
   alerts always penetrate — **the active workspace governs what Caye assumes you mean,
   never what she is allowed to tell you.** Otherwise `switch_workspace` silently becomes
   "mute the business I'm not looking at."
5. **Wire-only awareness, stated out loud, enforced in code.** Read-layer responses carry
   a `coverage` object (channels live, channels gated + why, last-received per channel)
   as *data*. Caye cannot answer "nothing came in" without it in front of her; the digest
   template renders it regardless. The 08-07 failure was **unhedged** ignorance, not
   ignorance — that's the property to fix.
6. **Hybrid push.** One digest per person per day + a hardcoded interrupt allowlist:
   guest chasing a held thread, hold past deadline, channel down, cron failed, Full
   Bimini Experience request, **real escalations**. Never an LLM urgency judgment —
   the model ignored its own ban list 7 times in 31.
7. **Weekly heartbeat floor.** Silence within a week is correct and expected. Silence
   across a week is indistinguishable from being dead, so Caye speaks at least weekly and
   says plainly that there's nothing, rather than manufacturing filler.
8. **`guest_served` splits real escalations from self-grading.** Set on the
   `lib/caye-reply.ts:2087` branch only — that path already sent the guest a reply before
   holding, so nobody is waiting. When true: no `human_agent_enabled`, no interrupt, one
   digest line, excluded from stale sweep. Row is kept as raw material for "is Caye
   actually accurate?" The other three hold paths (identity guard, high-stakes
   low-confidence, LLM `escalate`) stay real and do interrupt.
9. **Quiet hours and digest time move to the person** (`operator_allowlist`), workspace
   setting kept as fallback. Budget and quiet window must live on the same object.
   Quiet hours **defer** interrupts to the next open window, never delete them; the
   emergency floor (guest `target_date` inside 72h, channel down) penetrates.
   - Karenda: 07:30 Bahamas digest, existing quiet hours.
   - Lamar: **no quiet hours**, 07:30 digest.
10. **Resolution-aware per-person delivery cursor.** Each event tracks who it has been
    delivered to; before speaking, state is re-checked and anything since resolved is
    reported as resolved or dropped, never as pending. This is
    `activity-since.ts:99` `classifyResolution` generalised from holds to every event
    type and made the default path.
11. **Reading in Caye Direct does NOT mark seen.** It is read-only ("REPLIES VIA
    WHATSAPP"). Only an explicit act — replying, marking handled, resolving — clears an
    event. **Fail toward telling twice.** Being told something you know is an annoyance;
    not being told is the bug that opened this session.
12. **Backfill everything, seed every cursor to `now()`.** Backfill is one
    `INSERT … SELECT` per source table since it's all trigger-derived; history stays
    fully queryable, nothing historical is ever pushed. Standing rule:
    **backfilled events are born already-delivered** — any future backfill must seed
    cursors in the same transaction.
13. **Add `source` to `bookings`** (`caye` / `manual` / `import` / `unknown`). Without
    it the 616-row history poisons every metric and "Caye booked this" is
    indistinguishable from "someone typed it in."

---

## 3. Work plan, in dependency order

### Phase 0 — landmines (before any trigger fires)
- Migration in repo, not MCP. Cursor-seeding written into the same transaction as the
  backfill — a backfill that ships without it spams every operator.
- `source` column on `bookings`, existing rows → `import` / `unknown`.

### Phase 1 — the stream
- `workspace_events` table: `workspace_id`, `type`, `actor_kind`
  (`outside` / `caye` / `operator` / `system`), `is_failure`, `subject_table`,
  `subject_id`, `conversation_id`, `payload jsonb`, `occurred_at`,
  `origin` (`trigger` / `app`).
  **No `significance` column** — that was in the first draft of this brief and
  contradicts decision 3. The table stores facts (`actor_kind`, `is_failure`);
  reportability is derived at read time in TypeScript so the lens is one file
  to tune rather than a migration. `is_failure` exists because "should have
  happened and didn't" is not derivable from `actor_kind` alone.
- Triggers on `unified_messages`, `bookings`, `caye_escalations`, `connected_accounts`,
  `unified_conversations.human_agent_enabled`.
- Backfill + cursor seed, one transaction.
- Comment at each app-side write site pointing at the migration — triggers are invisible
  in the TypeScript and someone will otherwise assume nothing fires.

### Phase 2 — the read layer
- `get_recent_activity` re-pointed at the stream; stop dropping `escalationEvents` and
  `chaseMessages`.
- New: workspace-wide recent-inbound read (the tool that would have answered the 08-07
  question). No search term required.
- `coverage` object on every activity/digest response.
- Resolution re-check before anything is spoken.

### Phase 3 — hold split ✅ shipped 2026-08-07 (NOT the split originally planned)

**`guest_served` was dropped. Its premise had gone stale.** Re-measured before
building: all 8 self-rated escalations that have ever existed now show
`thread_still_held = false`. Not one is holding a thread — the pile drained on its
own between 08-03 and 08-07. Building it would have added a column, set it on a
branch producing ~4 rows a month, backfilled 8 already-cleared rows, and changed
nothing measurable. Deferred, not done; revisit if the self-rated pile regrows.

**What the held pile actually was — 23 threads, and the problem was elsewhere:**

| Workspace | Held | Composition |
|---|---|---|
| TropiTech Outreach | 19 | **18 = drafted cold outreach awaiting batch approval** |
| Bimini | 2 | both genuine — a complaint (07-24) and a policy call (07-25) |
| 29227a12 | 2 | — |

Drafted outreach shares `human_agent_enabled` with "a guest is waiting on you", so
every reader counted a batch-approval queue as pending attention:
`get_held_queue`, `get_today_summary.held_items`, the morning digest (both the count
and the oldest-aging-hold line), and `stale-hold-sweep`, which would actively chase
the operator about a queue they were deliberately letting fill up.

This is decision 1 ("route on who owes the next move") applied where the problem
turned out to be. **Nothing new is stored** — `metadata.hold_kind` was already being
written by `create-outreach-leads` and `outreach-nudge-scan`; the readers were
ignoring it. `lib/hold-kinds.ts` holds the predicate; `send_outreach_batch` now
imports the same `QUEUE_HOLD_KINDS` set it used to duplicate, so the send gate and
the read layer cannot drift.

Default is deliberately conservative: a hold with no `hold_kind` counts as needing
attention, so a hold path that forgets to set it surfaces rather than vanishing into
a queue nobody checks.

Effect on prod: TropiTech Outreach 19 → **1** attention item (18 queued), Bimini
unchanged at 2.

### Phase 4 — delivery
- Per-person cursor + explicit-action-only clearing.
- Per-person quiet hours / digest time on `operator_allowlist`.
- Daily digest, hardcoded interrupt allowlist, weekly heartbeat floor.
- Per-person budget enforcement in the outbound queue, in code.

---

## 3a. Found while shipping Phase 1

- **364 of 504 outbound messages have no `metadata.generated_by`** — Bimini 167 null vs
  102 tagged, TropiTech Outreach 168 null vs 31 tagged. The untagged ones on Outreach are
  the cold-outreach sends; attributing them to a human would assert Lamar hand-typed 168
  cold emails. They are now recorded as `actor_kind = 'unknown'` rather than guessed
  (`20260807e`), consistent with `bookings.source`.
  **This is the sharp limit of decision 2:** trigger-derivation guarantees *if the row
  exists, the event exists*. It does not guarantee correct attribution — a trigger can
  only record what the source row carries.
  **Fixed forward 2026-08-07** — `lib/message-authorship.ts` + `20260807g`. The root
  cause was not a missing tag but a wrong one: `/api/messages/send` hardcoded
  `metadata.sent_by = 'human'` and nothing recorded who *composed* the text. `sent_by`
  answers who clicked send; `authored_by` now answers who wrote it — `caye` (draft sent
  unedited), `human_edited` (owner changed Caye's draft first), `human` (no draft
  existed). Trigger precedence: `authored_by`, then `generated_by`, then `unknown`.
  `human_edited` is deliberately its own value. It maps to `actor_kind='operator'`
  because those are the operator's words, but `payload.authored_by` preserves that Caye
  drafted it — **that is the only accuracy signal the product has.** A draft the owner
  rewrites before sending is a graded wrong answer, and counting it as either a pure
  human send or a Caye send destroys the measurement.
  Historical rows are NOT backfilled: the draft a July send was or wasn't based on is
  gone, and inventing it would be the same manufactured fact `20260807e` refused to
  write. Pre-2026-08-07 outbound attribution stays `unknown` by design.
- **Six new SECURITY DEFINER functions were exposed as PostgREST RPC** to `anon` and
  `authenticated` on creation. `caye_workspace_for_conversation(uuid)` was the real one —
  a callable conversation-id → workspace-id enumeration primitive that bypasses RLS by
  design. Revoked in `20260807f`; triggers verified still firing afterwards.
  **Any future SECURITY DEFINER function in `public` needs the same revoke in the same
  migration.** Seven pre-existing functions carry the same exposure and were deliberately
  left alone — some are referenced by RLS policies and need their own review.

## 3b. Needs a human, not code — as of 2026-08-07

- **Jeff A Montenaro — complaint, held since 2026-07-24. Fourteen days.** Forced
  escalation via the sentiment cascade, `route_to = owner`, escalation row still open,
  thread still `human_agent_enabled`. A complaint from a guest of the one paying
  customer, unanswered for two weeks.
- **Sue Guilbert — policy hold since 2026-07-25.** Same shape, thirteen days.

Both were invisible underneath 17 outreach drafts before the Phase 3 split. Neither is
fixed by shipping anything; they want Karenda today.

## 4. Still open — not solved by this project

- **Bimini coverage.** Email-only for a business that almost certainly runs on WhatsApp
  and phone; WhatsApp structurally blocked by the personal-number problem. A perfect
  event stream still makes Caye perfectly aware of a minority of that business. This
  needs its own decision. It is the reason a $79/mo customer's assistant looks half-blind.
- **The inquiry→booking gap.** 79 inbound emails, 6 bookings logged, 30 days. Nobody at
  Bimini is looking at that number. Decision 3's "infer, then ask one specific thing"
  (*"the Hollands went quiet after I sent the Sunday price — did that one land?"*) is the
  path to closing it, but it is deliberately deferred until the stream exists.
- **Max's dead seat.** Never sent a message. Per the prior brief he is audience, not
  operator — confirm that's still the call rather than a broken invite.
- **Tell Karenda** about the digest/interrupt behaviour change before she discovers it.
- **Digest copy and format** — not designed. Bahamian directness, no soft American hedges.
- **Retention on `workspace_events`** — not decided.
- **Root defect upstream:** bookings created from conversations must carry
  `conversation_id` and `customer_email`. 10/616 linkage is why the ghosted-lead guard
  in the other brief is inoperative.
- **`booking_status` has no `completed` value.** The enum is
  `pending, confirmed, cancelled` — full stop. So it is not that no booking has ever
  completed; a booking *cannot* complete. Two consequences: outcome capture needs an
  enum change before anything else, and the auto-complete pass in
  [cold-followup-plan.md](cold-followup-plan.md) Phase 0 would have thrown on an
  invalid enum value rather than flipping 604 rows. That landmine is differently
  shaped than the brief described.
