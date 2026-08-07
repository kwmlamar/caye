# Cold follow-up + operator attention budget — plan

**Date:** 2026-08-03
**Status:** planned, not started
**Origin:** grilling session — "does Caye follow up on leads/bookings that went cold?"

---

## 1. Diagnosis (all figures verified against prod, Bimini workspace `653257d9`)

**The follow-up engine exists and has never run.** `app/api/caye/nudge-scan/route.ts`
implements three passes (auto-complete, review request, ghosted lead) with unit-tested
eligibility in `lib/nudge-eligibility.ts`. Evidence it has never executed:

| Signal | Value |
|---|---|
| `unified_conversations.nudge_sent_at` set | 0 of 666 |
| `bookings.review_requested_at` set | 0 of 612 |
| Bookings in `completed` status | 0 (604 past-dated still `confirmed`) |
| `nudge-scan` rows in `caye_cron_runs` | none |

It is not registered on cron-job.org, not in `lib/caye-agent/tools/admin/cron-registry.ts`,
and not wrapped in `recordCronRun` — so it cannot be triggered or health-checked from
Admin Shell either.

**The cold-thread population** (business spoke last, guest never replied, no booking):

| Thread state | Count | Silent 3d+ | Covered today |
|---|---|---|---|
| Not held, human replied last | 44 | 43 | nothing |
| Not held, Caye replied last | 17 | 16 | nudge-scan, if it ran |
| Held, Caye replied, no escalation | 3 | 3 | excluded (held) |
| Held, Caye replied, open escalation | 3 | 2 | digest nags owner |

**The booking guard is inoperative.** 615 bookings for Bimini: **10 have an email
address, 9 have a `conversation_id`.** So `booking_count > 0` in
`shouldSendGhostedLeadNudge` is always false. Matching cold threads to bookings by
**name** finds **15 of 71 already booked** — roughly 1 in 5 of the people the sweep
would email is already on the manifest.

**Operator attention was spent, not absent.** `caye_operator_messages`,
`operator_allowlist_id = 1` (Karenda Swain-Rolle, renamed "Mrs. Max" ~Jul 27 — one
person, two display names):

| Week | Her → Caye | Caye → her |
|---|---|---|
| Jun 08 | 14 | 14 |
| Jun 15 | 11 | 11 |
| Jun 22 | 55 | 61 |
| Jun 29 | 6 | 32 |
| Jul 06 | 0 | 48 |
| Jul 13 | 0 | 74 |
| Jul 20 | 15 | 53 |
| Jul 27 | 0 | 14 |
| Aug 03 | 0 | 3 |

June ran near 1:1 and she answered. July inverted — 122 messages from Caye across two
weeks with zero replies, **before** the vacation that started ~Jul 27. Read as
notification fatigue: Caye spends operator attention faster than she earns it.

**Escalation "resolution" is misleading.** `owner_responded_at` is stamped by
`operatorRepliedSince()` — a human reply *on the email thread*
(`app/api/caye/escalation-followup/cron/route.ts:152`). It does not mean the operator
answered Caye. It means she bypassed Caye and handled the guest herself — which is also
why 44 cold threads have a human as last sender.

**Current held pile:** 16 conversations, 6 stale 3d+, oldest held since 2026-07-07.

---

## 2. Decisions locked in this session

1. **Route on who owes the next move**, not on `human_agent_enabled`. "Held for owner"
   and "owner owes the next move" are different things.
2. **Human-replied threads:** Caye follows up, *gated on explicit permission from the
   owner*, obtained by phone — not via a WhatsApp prompt or digest item.
3. **Split the held pile at the source** rather than making Caye braver. The
   medium/low-confidence branch (`lib/caye-reply.ts:2087`) ships the reply to the guest
   and *then* holds the thread — the guest is already served, so it was never a review
   item.
4. **`guest_served` boolean on `caye_escalations`.** When true: don't set
   `human_agent_enabled`, no real-time WhatsApp ping, excluded from `stale-hold-sweep`,
   surfaced as one digest line. Keep the row — it is the raw material for "is Caye
   actually accurate?"
5. **Operator loop stays on WhatsApp, hard-rationed.** Volume killed engagement, not the
   medium. An email round-trip would inherit the same problem within a month.
6. **Default to acting, not asking.** For a 2–3 person operator with no ops manager,
   every "should I?" is a dropped ball.
7. **Budget: 3 operator messages/day/workspace**, enforced in code (June ran ~2/day and
   was answered; July ran ~10/day and was not). Surplus **evaporates** for anything Caye
   can handle herself; only real holds carry to the digest.
8. **Backlog: bounded trickle.** Backfill >14 days as handled; release the remainder
   newest-first at 5/day; Lamar reads batch one before it sends.
9. **Real holds get a deadline, not a queue.** Timer N = 24h weekdays, immediate if the
   guest's `target_date` is inside 72h. On expiry Caye answers with what she has,
   flagged as partial; falls back to an honest gap + real next step when there is
   nothing partial to offer. She may only restate facts already in the thread or
   workspace config — never fill the gap with a guess.
10. **Max is audience, not operator.** He gets the weekly `business_insights` read-out,
    not a back-office WhatsApp seat.

---

## 3. Work plan, in dependency order

### Phase 0 — landmines (must land before any cron runs)

- **Backfill `bookings.review_requested_at`** on every booking dated before today.
  Unconditional. Without this, the auto-complete pass flips 604 historical bookings to
  `completed` on its first run and the review pass emails all of them.
- **Fix `operator_allowlist` id 22** — Max's phone is `+2424730233`, missing the leading
  `1`. `+242…` routes to the Republic of the Congo. Correct to `+1242…`.
  No `caye_outbound_queue` row ever referenced that number, so his invite was never
  enqueued at all — two stacked failures.
- **Harden `normalizeE164`** (`lib/caye-agent/tools/write-low/add-team-member.ts:23`) to
  reject or auto-correct a `+242…` that is not `+1242…`.

### Phase 1 — the guard (blocks all sending)

- Replace the `booking_count` check in `shouldSendGhostedLeadNudge` with an identity
  match that works: email **and** normalised name, scoped to the workspace.
- **Fail closed** — any plausible match suppresses the follow-up. Fuzzy names ("Holly"
  vs "Holly Sands") resolve to *don't send*.
- Fix the upstream cause too: bookings created from conversations must carry
  `conversation_id` and `customer_email`. 1.5% linkage is the root defect.

### Phase 2 — drain the held pile by reclassification

- Add `guest_served` to `caye_escalations`; set it on the `lib/caye-reply.ts:2087`
  branch only. The other three hold-producing paths (identity guard, high-stakes
  low-confidence, LLM `escalate`) stay real holds.
- Apply the behaviour changes from decision 4.
- Backfill existing rows (`internal_context` begins `"Caye self-rated confidence="`) and
  clear `human_agent_enabled` on the affected threads. Those guests were served, some 27
  days ago.

### Phase 3 — attention budget

- Enforce 3/day/workspace in the outbound queue, in code, not prompt.
- Emergency floor for genuine urgency.
- Surplus evaporates unless it is a real hold.

### Phase 4 — wire the sweep

- Register `nudge-scan` on cron-job.org.
- Wrap in `recordCronRun`; add to `CRON_JOBS` so Admin Shell can trigger and report it.
- Trickle release per decision 8.

### Phase 5 — real-hold deadline

- Timer per decision 9, built on existing `target_date` + quiet-hours logic.
- Partial-answer generation constrained to known facts.

---

## 4. Blocked on a human, not on code

- **Call Karenda when she's back.** Why she stopped answering in early July is inferred
  from message counts. One sentence from her replaces the inference — and if the reason
  is "Caye kept asking things she should have known," the fix is different.
- **Get Max's or Karenda's explicit yes** on Caye following up on threads they handled by
  hand. 42 of 71 cold threads depend on it. Ask by phone.
- **Tell Karenda about the deadline behaviour** (decision 9) before she discovers it.
- **Turn on `business_insights` for Bimini.** It has never run. A non-technical owner
  paying $79/mo currently has no read-out of what he is buying.

---

## 5. Success criteria

Volume is too low for statistics. Judge on:

- Held pile trends to near zero and stays there.
- Operator inbound/outbound ratio returns toward 1:1.
- Of the first 20 follow-ups sent: how many replies, how many bookings, **how many
  complaints or "I already booked" responses** — the last one is the kill signal.
- Zero follow-ups sent to a guest with an existing booking. Any single instance means
  the Phase 1 guard is wrong and sending stops until it is fixed.
