# Cold-start — plan

**Date:** 2026-08-07
**Status:** Phase 1 shipped 2026-08-07 (semantic matching + candidate lifecycle closure).
Phases 2–4 designed, not started.

**Shipped:** `20260807h_fact_candidate_lifecycle` (migration, applied to prod),
`lib/business-fact-semantic-match.ts`, `confirm_fact_candidate` / `dismiss_fact_candidate`
tools, `maybeSuggestBusinessFacts` rewired to try semantic matching before filing a
duplicate, `back-office.ts` prompt updated to route confirmations through the new tools
instead of raw `add_business_fact`. Verified with a live smoke test against the real
Anthropic API using Bimini's actual duplicate clusters: the confirmed bug case (the
tram-stop meeting-point paraphrase) merged correctly; two genuinely-different sentences
correctly did NOT merge, validating the "prefer no match when unsure" design. 451 tests
passing, tsc clean.
**Origin:** grilling session — closing the loop opened in
[workspace-events-plan.md](workspace-events-plan.md)'s six-month framing: Phase 4 there
(delivery/digest) was deliberately deferred because onboarding confirmations are a third
message-delivery mode that would blow the 3/day operator budget on day one. This is that
design, done first.

---

## 1. Diagnosis (verified against prod, 2026-08-07)

**There's already more cold-start machinery than expected, and none of it has run.**

- **A WhatsApp discovery grill** (`lib/onboarding.ts`, shipped 2026-07-01) — adaptive,
  up to `MAX_DISCOVERY_QUESTIONS` (10), produces `system_prompt` / `tone` / `pricing_info`
  / `common_questions` / `cancellation_policy` / `escalation_rules` / `never_say`.
- **A chat-driven channel-connect walkthrough** (`lib/channels/slots.ts`, shipped
  2026-08-06) — one channel at a time, resumes from the OAuth callback.
- **A reactive fact-candidate detector** (`business_fact_candidates`,
  `lib/business-fact-suggestions.ts`, shipped 2026-07-05) — watches live owner replies
  for sentences repeated `OCCURRENCE_THRESHOLD` (3) times, proposes saving them via a
  WhatsApp ping.

All three exist. **None have been exercised end-to-end by a real signup.** Bimini's
`workspace_ai_config` row was created 2026-05-18 — six weeks before the discovery grill
existed — so her system prompt came from something else entirely. TropiTech Outreach
(created 2026-07-22, two weeks before the walkthrough shipped) has `channel_intake =
null`: even the founder's own workspace never ran it.

**The fact-candidate detector has produced zero output in its lifetime** — 8 rows total
across two workspaces, every one still `status = 'pending'`, max `occurrence_count = 1`.
Root cause confirmed from the actual rows, not inferred: `normalizeSentence` does exact-
string dedup with **zero fuzzy matching** (a deliberate tradeoff — "keeps false-merges at
zero at the cost of missing paraphrased repeats"). Bimini's own candidates from
2026-07-26 prove the tradeoff doesn't hold in practice:

> "Meeting Point: Resorts World Bimini Casino Tram Stop"
> "If you are arriving by cruise ship, please take the complimentary Resorts World
> Bimini tram from the pier to the Casino Tram Stop."

Same fact. Two unmerged rows. A second cluster from 07-29 — four separate
refund/cancellation sentences, obviously one real conversation — sits as four dead
`occurrence_count: 1` rows. A human never retypes a fact byte-identically across
separate emails, so exact-match dedup can essentially never fire. Separately, the
keyword-only classifier false-positived on TropiTech Outreach's own cold-outreach copy
("coordinating limo **pickups** and tours…") as a business-fact candidate.

**Consequence for scope:** "why has the live detector never fired" and "how would an
archive-mining pass judge two sentences as the same fact" are the same underlying
capability — semantic matching, not exact-string matching. Fixing the first without
building the second just moves the threshold; building the second without the first
inherits the same defect at larger scale. There was never a case for treating them as
sequential work.

**Also confirmed: no confirm/dismiss closure loop exists.** `add_business_fact` writes
straight to `business_facts` with `source: 'owner-direct'` and never touches
`business_fact_candidates`. When a candidate is proposed and the owner says "yes," the
general agent just calls `add_business_fact` — the original candidate row stays
`status = 'proposed'` forever, with no link to what it produced. There is no code path
that has ever set `status = 'resolved'` or `'dismissed'` as a result of an owner's
reply. This blocks Phase 4's correction-rate tracking outright — it's not a nice-to-have,
it's a hole in the loop.

---

## 2. Decisions locked this session

1. **Scope**: fix the zero-throughput root cause (exact-string dedup) as part of
   building semantic-match extraction, not as a separate patch — one capability serves
   both the live-repeat detector and archive mining.
2. **Trigger**: continuous rolling-window extraction, not a one-time onboarding job. A
   pure one-shot job is exactly the shape this codebase has a track record of building
   and never revisiting (Bimini's whole 6-week accumulation happened because the *only*
   extraction mechanism was purely reactive). First pass fires at signup; the same
   mechanism keeps running afterward on a rolling window (proposed: last 60–90 days),
   so it doesn't go stale when the business changes its policy six months in.
3. **Delivery**: a separate, time-boxed onboarding budget — **exempt from the
   steady-state per-person cap** (workspace-events-plan.md Phase 4, not yet built) —
   delivered as a handful of grouped batches by category (not one-at-a-time, not
   all-at-once), over roughly 72 hours. Rationale: the steady-state budget protects
   someone running their business from being interrupted while they're not expecting
   Caye to speak. Onboarding is structurally different — the owner just finished a
   10-question WhatsApp grill; they're primed and already talking to Caye.
4. **Rollout order**: new signups get archive-mining first. **Bimini is deliberately
   NOT backfilled until the mechanism has proven itself on at least one new signup.**
   Direct callback to the 2026-07 WhatsApp collapse — an unproven automated-messaging
   capability landing straight on the one paying customer, with no prior run to catch
   its failure modes, is a scar this session already has. An LLM inferring a stale
   cancellation policy or a rotated guide name mistaken for a fact lands directly in
   what Caye tells guests.
5. **Trust, staged by category** — reusing the four categories `add_business_fact`
   already defines, no new taxonomy:
   - `logistics` / `service_detail` — usable by Caye **immediately**, even before
     confirmation. Wrong ones are annoying, not costly; correcting later is cheap.
   - `policy` / `special_handling` — **held**, unusable in a guest reply until
     explicitly confirmed. These are the categories that show up as complaints when
     wrong (see Jeff Montenaro, `workspace-events-plan.md` §3b).
6. **Timeout for held facts**: reuse the existing escalation aging cadence
   (`lib/whatsapp/escalation-followup.ts` — daily for the first stretch, weekly after
   `AGED_BACKLOG_DAYS`-equivalent, then stops actively nagging while staying visible),
   rather than inventing new timeout logic or letting an unanswered high-stakes
   inference nag forever (the exact shape of the July collapse) or silently vanish.
7. **Graduation to Bimini**: a manual gate, not a formula. You decide, informed by a
   tracked per-fact outcome (confirmed-as-is / corrected / ignored) from the first real
   signup — a threshold computed from a sample size of one fact-set would be
   pretend-precision. The correction-rate tracking has to exist from day one for this
   decision to ever be more than a guess, which is why it's built in Phase 1 rather
   than bolted on later.

---

## 3. Work plan

### Phase 1 — semantic matching + candidate lifecycle ✅ shipped 2026-08-07

Fixes the confirmed zero-throughput bug and lays the schema every later phase needs.
Does **not** touch the reply pipeline, does **not** require a live signup to validate —
verified directly against Bimini's real duplicate clusters.

- `business_fact_candidates`: `source` (`live_repeat` | `archive_mining`, default
  `live_repeat`), `outcome` (`confirmed` | `corrected` | `ignored`, nullable),
  `outcome_at`, `resolved_fact_id` (→ `business_facts.id`).
- `business_facts.source` check widened to add `candidate-confirmed` alongside the
  existing `owner-direct` / `escalation-capture`.
- Semantic match: a single small LLM call (same shape as `decideNextDiscoveryStep`) —
  given a new candidate sentence and a workspace's existing pending candidates +
  confirmed facts, judges whether it's the same fact as one already known. Exact-string
  match stays as a free fast path before the LLM call, not replaced.
- New tools: `confirm_fact_candidate` / `dismiss_fact_candidate` — the missing closure
  loop. Confirming writes the `business_facts` row (`source: candidate-confirmed`) and
  closes the candidate (`outcome` derived by comparing final text to `sample_text` —
  identical ⇒ `confirmed`, different ⇒ `corrected`); dismissing sets `outcome: ignored`.

### Phase 2 — archive-mining extraction pass (designed, not built)

- Rolling-window read (60–90 days, all connected channels, not just email) over
  message history, LLM-synthesized into candidate standing facts — same semantic-match
  primitive from Phase 1 checks each candidate against existing facts/candidates before
  filing a new row.
- Guardrail against volatile/per-booking detail (the existing detector's
  `VOLATILE_MARKERS = ['guide']` precedent — a rotating guide name, a day-of price, a
  one-off circumstance must never be extracted as a standing fact). Needs an explicit
  exclusion instruction in the extraction prompt, not just reliance on category
  guessing.
- Trigger: hook into channel-walkthrough completion (`get_channel_status`'s `is_live`
  going true) for the first pass; cron for the ongoing rolling window.

### Phase 3 — onboarding delivery + staged usability (designed, not built)

- Batches confirmations by category, sent outside whatever budget mechanism
  workspace-events-plan.md Phase 4 ships, over the ~72h window.
- Wires category-staged usability (decision 5) into the reply pipeline — Caye's
  fact-retrieval at reply time needs to consult unconfirmed `logistics`/`service_detail`
  candidates alongside confirmed `business_facts`. This is the one piece of this design
  that touches `lib/caye-reply.ts` / `query_business_knowledge`, and should get its own
  scrutiny given the blast radius — every other phase here is additive and isolated.
- Wires the aging-cadence reuse (decision 6) for held `policy`/`special_handling`
  candidates.

### Phase 4 — Bimini backfill (deliberately gated, manual)

- Triggered by decision 7's manual gate, not automatically.
- Same mechanism as Phase 2/3, pointed at Bimini's 385-thread archive once a new
  signup's correction rate has been reviewed.

---

## 4. Still open

- **Phase 2's extraction prompt needs the volatile-detail guardrail validated**, not
  just specified — an LLM is more powerful than the old keyword detector and therefore
  also more capable of confidently extracting something that looks stable but isn't
  (a guide name, a seasonal price).
- **No new signup exists yet to run Phase 2/3 against.** Decision 4's rollout order has
  no live trigger until one arrives — acceptable per that decision, but worth surfacing:
  this design will sit unexercised until customer #2, the same way the three existing
  onboarding systems have sat unexercised until now.
- **Phase 3's reply-pipeline change is the one genuinely risky piece** — everything
  else in this plan is new, additive, and isolated from what Caye currently tells
  guests. That phase deserves its own review pass before it ships, not a rider on
  Phase 2.
- **workspace-events-plan.md Phase 4** (the actual per-person budget/digest/interrupt
  system) still needs to exist before decision 3 ("exempt from the steady-state cap")
  is enforcing anything real — right now there is no steady-state cap in code to be
  exempt from. Onboarding batches ship via direct send today, the same mechanism the
  existing candidate proposer already uses; the exemption becomes a real requirement
  the moment that budget system is built, not before.
