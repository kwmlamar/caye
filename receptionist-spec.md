---
doc: best-receptionist spec v1
status: spec — locked from 2026-06-22 grilling session, build pending
last_updated: 2026-06-22
related: STATE.md, BACKLOG.md, whatsapp-build-state.md, receptionist-spec.md
---

# Caye — Best-Receptionist Spec v1

The bar: **the best receptionist that has ever existed for a small tour operator. Better than any human front desk. Never misses a message, never gives wrong information, never leaves a customer waiting, and never bothers the operator with something it can handle itself.**

This spec is the output of the 2026-06-22 grilling session. It locks the design for Karenda's near-term build (the single pilot whose conversion clock is running) and explicitly parks everything downstream of the unanswered payment question.

---

## Scope

**IN:**
- Karenda ↔ Caye operator surface (back-office mode on WhatsApp + email drafts)
- Customer ↔ Caye on email (Zoho — the only channel with real customer traffic for Bimini)
- Operator identity fix (Caye knowing who her boss is)
- Held-item lifecycle: hold → customer ack → operator surfaces → resolution → stale-sweep

**OUT (parked, see Parked section for why):**
- Customer WhatsApp (Karenda doesn't get bookings there)
- Payment-link send (rail unknown)
- Post-payment logistics confirmation (downstream of payment)
- Day-before reminder (downstream of "is this booking actually paid?")
- BSP Embedded Signup
- Gmail integration
- Dashboard activity feed for routine traffic (Karenda doesn't use the dashboard)
- B2B classifier as a discrete build (Q7's per-message hold acknowledgement covers most of it)

---

## What exists today (audit)

**End-to-end live for Karenda:** Zoho email only. Inbound → `generateCayeAutoReply` (1618-line brain in `lib/caye-reply.ts`) with tools `check_availability` / `create_booking` / `find_bookings` / `cancel_booking` / `reschedule_booking` / `lookup_price` / `hold_for_human` / `send_reply`. Pending bookings sync to Zoho Calendar. Identity guard, dash sanitization, inbound classifier, owner-correction detection, voice-profile learning all running.

**Wired but unvalidated end-to-end:** WhatsApp / Messenger / Instagram inbound webhooks. All three call the same brain. None has been proven through a real customer flow.

**Back-office (operator) mode:**
- `lib/caye-agent/` — `cayeAgent({ mode: 'back-office' })` runs a Claude tool-loop against 20 registered tools (10 read, 6 low-risk write, 4 high-risk write) — `tools/registry.ts`
- `/api/webhooks/whatsapp-operator/route.ts` routes operator inbound to either the legacy held-item action dispatcher (`send`/`skip`/`edit`/`handled`/`mute`/`unmute`/`multi`) or `cayeAgent`
- `sendFreeFormWhatsApp` for synchronous chat replies; `caye_outbound_queue` for proactive notifications
- WABA `1482716173600181` exists but has **no phone number attached**; templates never submitted; not in Vercel env (per `whatsapp-build-state.md`)

**Operator surfaces in code:** dashboard (not used by Karenda), morning briefing cron, EOD summary cron, nudge-scan (review requests), `whatsapp-operator` webhook (back-office chat).

**Known bugs documented but not fixed:**
- `ai_enabled` ghost-column on `workspace_ai_config` — kill switch silently dead
- Voice-profile schema mismatch — `customers.ai_voice_profile` shape ≠ what `lib/voice-profile.ts` expects; never passed on email path
- `tool_choice: 'any'` forces a reply-or-hold every turn (no silence path)
- ChargeAnywhere receipt subject filter wrong (`/RECEIPT PAGE/i` vs actual `"Receipt"`)
- Legacy `bookings` table vs Zoho Calendar dual source of truth
- `service_pricing_tiers` empty for Specialty Experiences

---

## Diagnosed bugs (no design needed — go verify and fix)

### Bug 1 — Operator identity amnesia

**Symptom (Karenda's session):** Asked Caye who owns Bimini Island Tours and the contact info. Caye didn't know. Didn't realize she was talking to the owner herself.

**Root cause:** `buildBackOfficeSystemPrompt` (`lib/caye-agent/modes/back-office.ts:25-29`) reads `customers.full_name` and `customers.business_name` keyed by `id = workspaceId`. If those fields are NULL for Bimini, the prompt silently falls back to `"the owner"` / `"their business"`, producing the literal line *"the owner (the owner) is messaging you on WhatsApp right now."* No tool can recover from a prompt that doesn't tell Caye who she's talking to.

**Verify:** query `customers` for Bimini's workspace_id. Confirm `full_name` and `business_name` are populated. If NULL, this is just data — fix in onboarding intake.

**Permanent fix (spec'd below):** ship the workspace-profile schema + always-loaded prompt block (Q11 lock) so identity is a first-class concept, not a fallback-when-data-exists.

### Bug 2 — Read-tool keying mismatch

**Symptom (Karenda's session):** Asked Caye for recent customer inquiries. Caye said she couldn't access. Same tools work on TropiTech (Lamar's seed workspace).

**Root cause hypothesis:** read tools (`getRecentActivity`, `searchThreads`, `getRecentBookings`, etc.) query `.from('connected_accounts').eq('user_id', ctx.workspaceId)` and `.from('bookings').eq('user_id', ctx.workspaceId)`. The `whatsapp-operator` webhook gets `workspaceId` from `workspace_ai_config.workspace_id`. If Bimini's `connected_accounts.user_id` or `bookings.user_id` is a different value than `workspace_ai_config.workspace_id`, the tools return empty. The conversation path doesn't touch these tables, so Caye replies — but factual queries are blind.

**Verify:** for Bimini, compare:
- `workspace_ai_config.workspace_id`
- `connected_accounts.user_id`
- `bookings.user_id`
- `customers.id`

If they don't all match, that's the bug. Pick the canonical key, write a backfill migration, fix the tools that read the wrong column.

---

## Locked design decisions

### Q1 / Customer WhatsApp — PARKED
Karenda gets bookings via email, not WhatsApp. Don't focus customer-side WhatsApp here.

### Q2 / Payment loop — PARKED
Bimini's payment rail isn't confirmed (may not be WeTravel). Everything downstream — link-send, receipt parsing, paid-vs-pending status, post-payment logistics confirmation, day-before reminder for paid bookings — blocks on this discovery. Surface it as a question to Karenda before building.

### Q3 + Q5 + Q6 + Q8 → REFRAMED post Q9

Original lock proposed dashboard-as-operator-surface. Karenda doesn't use the dashboard. Reframe locked:

**Karenda's operator surface = Zoho email + back-office WhatsApp chat.** Not the dashboard.

**Held-item resolution = Zoho drafts.** When Caye holds a thread, she writes her proposed reply as a **Zoho draft on that thread** (not just as an internal note). Karenda opens her email client in the morning, sees drafts waiting in the customer threads, edits and sends in Zoho. No new app to learn.
- *Implementation:* the existing `sendZohoReply` in `lib/email-ai.ts` is used for autonomous sends. Add a `createZohoDraft(threadId, body, workspaceId)` companion. In `zoho-email/route.ts`, on `decision.action === 'hold'`, call the new function with `decision.proposedReply` after storing the internal note.
- *Note:* Karenda's normal email behavior — replying directly in Zoho — already triggers the `detectOwnerCorrection` voice-learning path on the next poll. Drafts she edits and sends from Zoho feed the same loop.

**Stale-hold sweep.** Extend `nudge-scan` cron to scan for held threads where the most recent business message is older than N business hours (default 4h waking, immediate at 7am for overnight) and Karenda hasn't sent anything since. Sends Karenda a single rollup email per sweep: "3 drafts waiting on your call: Sarah (Heritage Sat), Daniel (custom transport), Maria (refund question)." Uses the existing Zoho send infrastructure; no new channel. Business-hours math uses the existing `lib/whatsapp/schedule.ts` quiet-hours config.

**Activity feed for the dashboard = deferred.** Build only when there's a real audience (a future customer who actually uses the dashboard). For now, Lamar audits by logging into Karenda's workspace and reading her Sent folder.

### Q4 / Shadow operator — LOCKED

Add to `workspace_ai_config`:
- `notifications_paused boolean DEFAULT true` — hard kill on all outbound to canonical operator. Default `true` for new workspaces; explicitly flipped to `false` when the loop has been validated.
- `operator_notification_override_phone text NULL` — when set, all WhatsApp pings (hold pings, urgent, EOD, morning, stale-hold pings if any) route here instead of `operator_whatsapp_number`. Karenda's number stays as canonical operator identity (used for back-office allowlist, voice-profile linkage, identity guard).

Behavior: pings are only sent if `notifications_paused = false`. When sending, destination = `override_phone` if set, else `operator_whatsapp_number`. One column per concern, both default safe.

For Bimini's current state: set `notifications_paused = true`, `override_phone = +13342219466` (Lamar's). When ready, flip pause to false; pings go to Lamar, never Karenda, until override is cleared.

### Q7 / Customer-facing hold acknowledgement — LOCKED

Caye's `hold_for_human` tool already takes `reason`, `note`, and `proposed_reply`. Add an optional `customer_acknowledgement` field.

When set:
- The webhook sends it to the customer immediately as a normal outbound message (via `sendZohoReply` on email).
- Persists as `unified_messages` row with `generated_by='caye'`, normal `sender_type='business'`.
- Held card in any audit surface shows the ack as a sub-line under the hold ("Caye told them: 'Thanks — checking on this, back to you shortly.'").

When empty:
- Silence is the answer. Used for: newsletters, vendor pitches, anything the existing identity-guard + scope rules already would have filtered.

System prompt update needed in `caye-reply.ts`: teach Caye when to populate the field. Default copy guidance: warm, short, no commitments on timing, never invents a price or a date. Examples:
- "Thanks — let me check on that and get back to you shortly."
- "Got your note, will be in touch about timing later today."

Newsletter / vendor pitch / spam: leave empty (let Caye explicitly justify silence in the `note` field for auditability).

### Q8 / Held-item SLA — see reframe under Q3+Q5+Q6+Q8

### Q9 / Voice correction loop — LOCKED with caveat

Karenda's voice profile is "okay, could be better" (Lamar's assessment, 6/10 ish).

Decision: keep the existing `detectOwnerCorrection` heuristic (fires when Karenda sends after Caye in the same thread). Since the held-item resolution surface is now Zoho drafts (not a dashboard form), every edit Karenda makes happens *inside Zoho* and gets caught by the existing email-poll correction loop. **No new explicit-capture mechanism needed.**

Caveat: this only works if Karenda's poll route correctly picks up edited drafts vs Caye's original send. Verify: when Karenda edits a draft Caye wrote and sends it, does the email poll see the edited body (not the draft she started from)? Should be a normal sent-mail entry; should work, but worth confirming with one real test.

The thinner-bottleneck issue: improving the *baseline* voice profile is more leverage than catching corrections. Audit the current voice profile state for Bimini; if it's thin, re-run the discovery pipeline with more of Karenda's sent mail history before tuning corrections.

### Q10 / Back-office tools — LOCKED

All 20 tools live in v1. Test in real time. Risk acknowledged: high-risk writes (`send_reply`, `confirm_booking`, `reschedule_booking`, `cancel_booking`) can land real customer-facing actions on Karenda's behalf. The existing prompt already enforces a draft-and-confirm pattern for these (back-office.ts:65-73). Trust the gate, watch the logs.

Implication: logging quality matters more than usual. Verify Vercel logs reliably capture `[caye-agent/execute]` and `[whatsapp-operator]` entries with workspace ID and tool name. If not, add structured logging before flipping `notifications_paused = false` for Bimini.

### Q11 / Operator identity — LOCKED

Always-loaded "WHO YOUR BOSS IS" prompt block. No tool round-trip for basic identity questions.

**Schema additions** (extend `customers`, since it's already keyed by workspace_id):
- `business_legal_name text`
- `business_email text`
- `business_phone text`
- `business_address text`
- `business_tax_id text`
- `business_license text`
- `operator_preferred_name text` — what they go by ("Karenda")
- `operator_personal_email text`
- `operator_personal_phone text`
- `team_notes text` — free text ("Max is my husband, helps run the boats. Day job at Foundation Resilience.")
- `business_hours jsonb` — `{ mon: { open: "08:00", close: "17:00" }, ... }`

**Prompt block** — add after the existing "WHO YOU ARE TALKING TO" section in `buildBackOfficeSystemPrompt`:

```
WHO YOUR BOSS IS (the operator you're working for)
- Name: {full_name} (goes by {preferred_name})
- Business: {business_name} ({business_legal_name})
- Contact: {business_email}, {business_phone}
- Address: {business_address}
- Hours: {business_hours formatted}
- License / tax: {business_license}, {business_tax_id}
- Notes: {team_notes}
- Personal contact for {preferred_name}: {operator_personal_email}, {operator_personal_phone}
```

Each line skipped if its field is NULL. Token cost is fine (~500 max).

**Onboarding gap:** none of these fields are currently collected. Add an "About your business" step to the onboarding wizard — the same form is the settings panel for editing later. Without this UI, the schema addition is dead weight.

---

## Parked (with reasons)

| Item | Reason parked | Unblocker |
|---|---|---|
| Customer WhatsApp | Karenda has no customer traffic there | (none — not on roadmap) |
| Payment-link send | Don't know Bimini's rail | Ask Karenda what payment processor she uses |
| Post-payment logistics confirmation | Depends on receipt detection | Payment rail resolved |
| Day-before reminder | Doesn't fire for unpaid bookings without breaking; semantics unclear | Payment status semantics resolved |
| ChargeAnywhere subject filter fix | Only relevant if ChargeAnywhere is the rail | Payment rail confirmed |
| BSP Embedded Signup | Only relevant when Karenda's customer WhatsApp goes live | Customer WhatsApp deprioritized |
| Gmail integration | Bimini is Zoho; no Gmail prospect actively closing | Add a Gmail prospect to pipeline |
| Dashboard activity feed | Karenda doesn't use the dashboard | Customer who does shows up |
| Zoho-canonical `bookings` retirement | Not on critical path; current dual-write tolerable | After Karenda converts |
| `ai_enabled` kill switch fix | Real bug but no acute symptom (Karenda hasn't asked to pause) | Karenda asks, OR pre-conversion safety pass |
| `tool_choice: 'any'` silence path | Real but secondary | After voice quality audit shows it as the bottleneck |
| Pricing catalog completeness (`service_pricing_tiers`) | Operational data fix, not design | Just load the rows |

---

## Open verification questions (action items, not design)

1. **Data check — Bimini `customers` row.** Are `business_name`, `full_name`, and the new Q11 fields (or at least the ones that exist today) populated? If not, the identity bug repeats forever.

2. **Data check — Bimini key alignment.** Compare `workspace_ai_config.workspace_id`, `customers.id`, `connected_accounts.user_id`, `bookings.user_id`. They should all be the same UUID. If they're not, that's Bug 2.

3. **Voice profile audit.** Read 10–20 of Caye's recent sends from Karenda's Sent folder. Score voice fidelity. Decide whether the bottleneck is the baseline profile (re-run discovery with more samples) or the correction loop (currently fine).

4. **Payment rail discovery.** Ask Karenda directly: how do customers actually pay her today? WeTravel? Direct bank transfer? Cash on arrival? PayPal? Stripe? This is one question; it unblocks an entire downstream column of this spec.

5. **Logging audit.** Tail Vercel logs during a back-office WhatsApp session. Confirm `[caye-agent/execute]` and `[whatsapp-operator]` entries include workspace ID, tool name, ok/error. If not, add structured logging before flipping `notifications_paused = false`.

6. **Held-item Zoho draft test.** When Caye writes a draft into Karenda's Zoho drafts folder and Karenda edits + sends, does the email-poll correction loop see the edited body? Verify with one test thread.

---

## Build order (recommended)

Sequenced for fastest path to "Karenda converts." Each block is roughly a half-day to a day of focused work.

**Block 1 — Unblock back-office reliability (Bugs 1 + 2, then Q11):**
- Verify and fix `customers` row data for Bimini (open Q1)
- Verify and fix table-keying mismatch (open Q2)
- Schema additions for operator identity (Q11)
- Settings UI / onboarding intake for the new fields
- Update `buildBackOfficeSystemPrompt` to load and inject the WHO YOUR BOSS IS block
- Karenda smoke test: "who am I?", "what's my email?", "show me recent inquiries", "what's on the calendar Saturday?"

**Block 2 — Held-item lifecycle (Q3+5+6+8 reframe + Q7):**
- `createZohoDraft` helper in `lib/email-ai.ts`
- Wire the email hold path to write Zoho drafts (not just internal notes)
- Add `customer_acknowledgement` field to `hold_for_human` tool + system prompt
- Webhook sends the ack when present
- Extend `nudge-scan` cron with stale-hold sweep → rollup email to operator

**Block 3 — Notification routing (Q4):**
- Migration: add `notifications_paused` and `operator_notification_override_phone` to `workspace_ai_config`
- Update `enqueueOutbound` and `enqueueHoldPing` to respect both flags
- Bimini setup: `paused=true, override=+13342219466` until validated
- (Implicitly gated by the operator WhatsApp WABA setup — see `whatsapp-build-state.md`. If notifications stay off for the v1 build, the override field is a future-proof prep, not active today.)

**Block 4 — Verification + soft launch:**
- Logging audit (open Q5)
- Voice profile audit (open Q3)
- Payment rail conversation with Karenda (open Q4)
- Smoke test full loop, then flip Bimini's `notifications_paused = false` with override still pointed at Lamar
- Watch one real week

**Then:** unparked items in the order their unblockers land.

---

## Decisions deferred to a later grilling

These came up in the session but weren't worth resolving today:

- B2B / commercial-terms classifier as a discrete build vs. relying on Caye's per-message judgment (Q7's `customer_acknowledgement` covers most of the customer-facing experience for B2B). Revisit if real B2B threads on Bimini show poor classification.
- Voice profile schema mismatch fix (`customers.ai_voice_profile` shape vs `lib/voice-profile.ts` expectation). Real bug; not acute.
- Held-item second-stage auto-customer-follow-up (Q8 option C). Revisit after a month of held-item data.
- Multi-recipient operator model (Q4 option B). Revisit when there's a second shadow case.
- Voice corrections via explicit capture endpoint (Q9 option B/C). Heuristic loop is fine for now.

---

*Source: 2026-06-22 grilling session, locked decisions from Q1–Q11 (with Q5/6/8 reframed mid-session per Karenda's actual workflow).*
