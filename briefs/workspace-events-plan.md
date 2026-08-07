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

### Phase 3 — escalation split
- `guest_served` on `caye_escalations`, set on `caye-reply.ts:2087` only.
- Backfill existing rows (`internal_context` begins `"Caye self-rated confidence="`),
  clear `human_agent_enabled` on those threads. Current pile: 16 held, 6 stale 3d+,
  oldest since 2026-07-07 — some served a month ago.

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
  only record what the source row carries. **Fix is upstream: every Caye send path must
  set `metadata.generated_by`.** Until then "did Caye or a human handle this?" is
  unanswerable for 72% of outbound, and the "you sent 31, got 3 replies" read-out the
  stream was partly built for cannot be trusted.
- **Six new SECURITY DEFINER functions were exposed as PostgREST RPC** to `anon` and
  `authenticated` on creation. `caye_workspace_for_conversation(uuid)` was the real one —
  a callable conversation-id → workspace-id enumeration primitive that bypasses RLS by
  design. Revoked in `20260807f`; triggers verified still firing afterwards.
  **Any future SECURITY DEFINER function in `public` needs the same revoke in the same
  migration.** Seven pre-existing functions carry the same exposure and were deliberately
  left alone — some are referenced by RLS policies and need their own review.

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
