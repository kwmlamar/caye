# Standing rules — teaching Caye a constraint that actually holds

**Date:** 2026-08-08
**Status:** Spec only. Nothing built. No schema, no tools, no code.
**Origin:** Emily Sherman / Full Bimini Experience thread, 2026-08-08 — Caye quoted
$645 and offered to hold a date on a package the owner is supposed to price herself.
**Related:** [workspace-events-plan.md](workspace-events-plan.md) — same "route on who owes
the next move" principle, applied to authority rather than attention.

---

## 1. Diagnosis (verified against prod, 2026-08-08)

The presenting bug was fixed this morning by hardcoding a `full_bimini_experience`
trigger in `lib/forced-escalation.ts` (commit `19b25f9`). That fix is correct and should
stay until this replaces it — but **needing a repo commit to teach a customer's owner
a rule about her own business contradicts the product thesis**. Karenda should be able to
say it once in WhatsApp.

Investigating why she couldn't turned up three stacked failures, not one.

### 1.1 Capture is a coin flip

Karenda taught Caye a real Full Bimini policy over WhatsApp on 2026-08-07. It did not
persist. Exact sequence from `caye_operator_messages`
(workspace `653257d9`, `operator_allowlist_id = 1`, verified via allowlist join — *not*
`operator_name`, which is unreliable for attribution):

| Time (UTC) | Who | What |
|---|---|---|
| `02:01:54` | Karenda | *"for the full bimini you will require 50% to hold the reservation and the balance 7 days prior to the travel"* |
| `02:02:07` | Caye | writes it into the draft — **no `add_business_fact` call** |
| `02:04:01` | Karenda | *"our payments are with an invoice sent to them"* + beach detail |
| `02:04:11` | Caye | *"two things to save"* → **two `add_business_fact` calls** |
| `02:10:18` | Caye | *"Policy saved"* — this was the **cancellation** policy, a third thing |

Confirmed absent: no row in `business_facts` and no row in `business_fact_candidates`
for workspace `653257d9` matches `%50%`, `%deposit%`, `%balance%`, or `%7 days%` — only
the cancellation policy (the `$30–$50` admin fee) matches, which is unrelated.

**The deposit rule survived exactly one draft and evaporated.** The consequence is
visible one day later: on 2026-08-08 Caye quoted Emily Sherman $645 for the Full Bimini
Experience with no deposit terms at all.

The discriminator was phrasing. *"Can you mention to her that…"* read as a one-time
drafting instruction; *"our payments are with an invoice"* read as a standing fact. That
judgment is made by the model, in the moment, with nothing governing it.

### 1.2 The operator is never told what was kept

Karenda has no way to know which of her sentences became permanent. Caye said "Policy
saved" once in that conversation, about a different policy than the one being discussed
two minutes earlier. From the operator's seat, all three instructions looked equally
received.

This is the trust bug underneath the memory bug. Even a perfect capture rule is worth
little if the owner can't tell what stuck.

### 1.3 The candidate pipeline doesn't watch the operator

`business_fact_candidates` has 7 rows for Bimini. **All 7 are `source: 'live_repeat'`** —
mined from Caye's own outbound emails (`lib/business-fact-candidate-detection.ts`), never
from what the operator says. All 7 are `status: 'pending'`; `proposed_at` is null on every
one, so none has ever been surfaced to Karenda.

So the safety net that could have caught 1.1 doesn't cover operator speech at all, and its
output has never reached a human.

### 1.4 Even when captured, it's advisory

`business_facts` are rendered into the system prompt as prose
(`formatBusinessFactsBlock`, `lib/business-facts.ts:39`) and loaded on every reply
(`lib/caye-reply.ts:1992`). That is the right mechanism for knowledge. It is the wrong
mechanism for a constraint: the measured disobedience rate on explicit prompt
instructions in this codebase is ~23% (7 of 31 outreach follow-ups shipped banned
phrases, 2026-08-01), and the same pattern produced two contradictory deposit figures to
one customer on 2026-08-06 (`lib/policy-figure-guard.ts` exists because of it).

A rule like *"never quote this package yourself"* fails open, silently, into a
customer's inbox.

### 1.5 `standing_rules` is not the answer as built

The table exists and is **empty (0 rows)**. It is only touched by CRUD helpers in
`lib/data/mobile.ts:569-601` and is never read by the reply engine. Its shape is
`rule_text text` — free prose. Wiring it up as-is would reproduce 1.4 with an extra table.

---

## 2. The classification boundary

This is the load-bearing decision. Everything else is plumbing.

**Knowledge** describes the world. If Caye ignores or misstates it, a guest gets
something inaccurate, and a human can correct it in the next message.
→ `business_facts`, prose in prompt. **Works today. Leave it alone.**

**Constraint** restricts Caye's own authority. If Caye ignores it, she *takes an action
she wasn't allowed to take* — quotes a price, holds a date, confirms a booking — and it
has already reached the customer.
→ structured row, evaluated deterministically before the model runs.

**The test:** *if the model ignored this sentence, would a customer receive something we
cannot take back?* Yes → constraint. No → knowledge.

Worked examples from real Bimini data:

| Instruction | Class | Why |
|---|---|---|
| "meeting point is the pink building by the dock" | knowledge | wrong → guest walks to the wrong dock, fixable |
| "we don't run tours in heavy rain" | knowledge | describes the world |
| "cancellations only for illness, death, weather" | knowledge | describes policy; Caye stating it is the desired behavior |
| "bring Full Bimini bookings to me" | **constraint** | removes Caye's authority to quote/hold |
| "50% deposit to hold, balance 7 days prior" | **borderline — see below** | |
| "don't bother me with sales pitches" | **constraint** | governs Caye's routing behavior |

The deposit rule is the interesting case. It is knowledge *(these are the terms)* that
implies a constraint *(don't confirm a hold without collecting them)*. **v1 files it as
knowledge** — the fact block is the right home for terms — and does not attempt to derive
a constraint from it. Deriving obligations from stated facts is a research problem; guessing
at it produces exactly the over-escalation described in 5.1. Flagged as an open question.

---

## 3. Schema (proposed)

Do **not** extend `standing_rules` — the free-text column is the thing that makes it
useless, and it has zero rows, so there is nothing to migrate. Drop it or leave it
orphaned; new table:

```
caye_standing_rules
  id                uuid pk
  workspace_id      uuid not null
  trigger_type      text not null   -- 'service_mention' | 'keyword'
  match_value       text not null   -- 'Full Bimini Experience'
  action            text not null   -- v1: 'escalate' only
  route_to          text not null   -- 'owner' | 'founder' | 'both'
  is_active         boolean not null default true
  times_fired       integer not null default 0
  last_fired_at     timestamptz
  created_by        text not null   -- caller role
  source_message_id text            -- the operator wamid that created it
  created_at        timestamptz
  updated_at        timestamptz
```

Deliberately narrow for v1:

- **Two trigger types only.** `service_mention` matches a catalog service name
  case-insensitively; `keyword` matches a literal phrase. No regex authored by an LLM —
  see 5.2.
- **One action.** `escalate`. Not `block`, not `require_approval`, not custom replies.
  Everything Karenda has actually asked for reduces to "bring it to me."
- **No customer-facing template column.** The customer message comes from the same locked
  `TEMPLATES` enum that `lib/forced-escalation.ts:59` already uses — controlled strings,
  never LLM-generated, so wording can't drift per-rule. A generic
  `standing_rule` template covers v1.
- **`source_message_id`** so "why does Caye do this?" is answerable by pointing at the
  message where the owner said it.

---

## 4. Enforcement path

One insertion point, already the right shape:

`lib/caye-reply.ts:1910` currently calls `detectForcedEscalation(inbound.body, inboundCategory)`.
Layer the data-driven rules there:

1. Hardcoded triggers evaluate first (complaint, b2b, refund, custom_request) —
   these are platform-level safety and outrank a workspace rule.
2. If none fire, load active rules for the workspace and evaluate them
   deterministically against the inbound body.
3. A match returns the **same `ForcedEscalation` object shape** the hardcoded path
   returns, so everything downstream — `applyEscalation`, the operator brief in
   `lib/operator-brief.ts`, the `caye_urgent_hold` ping — works unchanged.
4. Increment `times_fired` / `last_fired_at`.

Because it returns before the LLM runs, the model never sees an opportunity to disobey.
Same guarantee the hardcoded trigger has today.

**`full_bimini_experience` then becomes one row and the hardcoded variant is deleted** —
from `ForcedTrigger`, `TEMPLATES`, `PING_LABELS`, `FULL_BIMINI_EXPERIENCE_PATTERN`,
`detectForcedEscalation`, plus the two `Record<BriefTrigger, string>` maps in
`lib/operator-brief.ts:213,225` that broke the build when it was added (`10b0a2e`).
That deletion is the acceptance test for this whole brief: if the row can't fully replace
the hardcode, the design is wrong.

---

## 5. Failure modes

### 5.1 Over-triggering (highest risk)

A rule on the word `"private"` would fire on a large share of Bimini's inbound — the
existing `CUSTOM_REQUEST_PATTERN` already matches "private tour" and it is one of the
noisiest triggers. An owner who escalates everything gets buried and stops reading, which
is worse than the status quo because it degrades the pings that matter.

**Mitigation:** before a rule activates, dry-run `match_value` against the last 90 days of
`unified_messages` for that workspace and report the count back:
*"That would have fired 34 times in the last 90 days — about 3 a week. Still want it?"*
Cheap (one `ilike` count), and it turns an abstract rule into a concrete volume the owner
can judge. **This is the single most valuable part of the design and should not be cut.**

### 5.2 LLM-authored match patterns

If Caye writes a regex, it will eventually write one that matches everything or nothing.
v1 restricts matching to literal substrings and catalog service names. `service_mention`
should validate against `booking_services` and reject a name that isn't in the catalog,
which also catches typos.

### 5.3 Write-only memory

If Karenda can create rules but not see or remove them, this becomes an accumulating pile
of invisible behavior — the same class of problem as a config field nobody reads. `list_standing_rules`
and `remove_standing_rule` ship **in the same phase** as the create tool, not later.

### 5.4 Silent staleness

A rule stays true until it doesn't. `times_fired` and `last_fired_at` exist so a rule that
has fired 0 times in 90 days can be surfaced for review. Not automated in v1; the columns
just have to be there from the start so the data accumulates.

### 5.5 Misclassification, both directions

- Knowledge filed as constraint → over-escalation, owner annoyed, recoverable.
- Constraint filed as knowledge → **the current bug**, silent, reaches customers.

Asymmetric, so bias toward constraint on genuine ambiguity — but pair it with 5.1's volume
preview so the cost of that bias is visible before it lands.

### 5.6 Rule conflicts

Two rules matching one inbound: v1 fires the first by `created_at` and does not attempt
merging. With one action type and owner routing, a conflict is near-meaningless in v1 —
it becomes real if `action` ever expands.

### 5.7 Confirm-back that overstates

The confirmation must describe the *mechanism*, not just agree. Not "got it, I'll bring
those to you" — that is what a prompt-only system would also say, and it is what Caye
effectively said on Aug 7 before dropping the rule. Closer to: *"Saved. Any message
mentioning Full Bimini Experience now comes straight to you before I reply — that would
have been 12 messages in the last 90 days."*

---

## 6. Phases

| Phase | Scope | Ships value alone? |
|---|---|---|
| **0** | Confirm-back on the *existing* `add_business_fact` path — Caye states plainly what she saved, every time | Yes — fixes 1.2 with no schema change |
| **1** | Table + `list_standing_rules` + `remove_standing_rule` | No |
| **2** | `add_standing_rule` with classification guidance in the tool description + 5.1 volume preview + 5.7 confirm-back | Yes |
| **3** | Enforcement at `caye-reply.ts:1910`; migrate Full Bimini to a row; **delete the hardcode** | Yes — completes the loop |
| **4** | Capture rule for 1.1: owner asserting policy is save-by-default, not model judgment | Yes |

Phase 0 is worth doing regardless of whether the rest is ever built. Phase 4 is separable
and arguably higher-value than 1–3, since 1.1 is the failure that actually cost a customer
interaction — worth considering reordering.

---

## 7. Open questions for Lamar

1. **Deposit-style rules** (§2) — leave as knowledge, or is "don't confirm a hold without
   stating the deposit" a constraint worth expressing? Affects whether `action` needs a
   second value in v1.
2. **Who can create rules** — owner only, or staff too? `add_business_fact` is
   `roles: ['owner', 'founder']`. Same for rules, or tighter given they remove Caye's
   authority?
3. **Founder visibility** — should a customer creating a standing rule notify you? It
   silently changes what Caye does for a paying workspace.
4. **Phase 4 first?** — see §6.
5. **Model upgrade is unrelated.** Caye runs `claude-sonnet-4-6`; `claude-sonnet-5` is
   available. Worth doing for quality, but it would not have prevented any failure in this
   brief, and shipping it alongside would confound whether this design worked.
