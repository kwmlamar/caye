---
doc: receptionist-spec Block 1 + Block 2 (partial) — build handoff
status: code staged locally, NOT applied to production
last_updated: 2026-06-22
source: receptionist-spec.md
---

# Receptionist Spec — Build Status (handoff from 2026-06-22 nap session)

What got done while you slept, what's blocked on your authorization, what changed about the spec along the way.

## ✅ Code staged in the repo (typechecks clean)

### Block 1 — Operator identity fix

**Migration file (NOT applied):** [supabase/migrations/20260622_operator_identity_and_shadow.sql](supabase/migrations/20260622_operator_identity_and_shadow.sql)

Adds:
- `customers.operator_personal_phone text`
- `customers.operator_personal_email text`
- `customers.team_notes text`
- `workspace_ai_config.notifications_paused boolean NOT NULL DEFAULT true`
- `workspace_ai_config.operator_notification_override_phone text`

**Why the migration is smaller than spec'd:** When I queried the live `customers` schema, most of what Q11 wanted already exists or is covered by the `business_brief` jsonb that onboarding populates. Specifically: `business_name`, `contact_email`, `contact_phone`, `whatsapp_business_number`, `timezone`, `business_hours`, `booking_url`, `website_url`, and `business_brief` (which holds address, tagline, website, services catalog, payment methods, availability) all already exist. So the migration only adds the *operator-personal* contact (distinct from business contact) + the free-form `team_notes` field. Cleaner than 11 new columns.

**Code changes:**
- [lib/caye-agent/modes/back-office.ts](lib/caye-agent/modes/back-office.ts) — new `OperatorProfile` interface; `buildBackOfficeSystemPrompt` signature changed from `{businessName, operatorName, voiceProfile}` to `{profile, voiceProfile}`; injects a "WHO YOUR BOSS IS" block with all available identity fields, eliding any line whose value is missing.
- [lib/caye-agent/index.ts](lib/caye-agent/index.ts) — loads the richer fieldset from `customers`. Best-effort second query for the three new columns (`operator_personal_email`, `operator_personal_phone`, `team_notes`) that swallows errors pre-migration, so the back-office path keeps working before the migration is applied.

**Data-bug detection built in:** the prompt builder detects the case where `customers.full_name` equals `customers.business_name` (Bimini's exact situation — both are `"Bimini Island Tours"`). In that case it falls back to "the owner" and adds an explicit instruction so Caye says she doesn't have the operator's personal name on file yet, rather than reading the business name as the human's name. This means *the identity prompt is better even before the data is fixed.*

### Block 2 — Customer-facing hold acknowledgement (Q7)

- [lib/caye-reply.ts](lib/caye-reply.ts) — `hold_for_human` tool gains optional `customer_acknowledgement` parameter. System prompt teaches Caye when to populate (real customer with a question) vs. leave empty (newsletter, vendor pitch, automated bounce). Identity-guarded same as `proposed_reply` — a leak gets dropped silently rather than sent. `CayeAutoReply` type extended with `customerAcknowledgement` on the hold variant.
- [app/api/webhooks/zoho-email/route.ts](app/api/webhooks/zoho-email/route.ts) — on hold, if `customerAcknowledgement` is set, sends it via `sendZohoReply` immediately and persists as a normal outbound `unified_messages` row with `metadata.is_hold_acknowledgement: true`. The internal note also stores the ack for audit. Send failures are logged but don't block the hold — operator still gets pinged regardless.

**Not done for messenger/instagram/whatsapp customer webhooks** — those channels have no real customer traffic for Bimini per Q1, so wiring them adds surface area for no immediate value. The pattern is now in `caye-reply.ts` though, so adding them later is a 5-line change per webhook.

## 🚫 NOT done — requires your authorization or a discovery

| Item | Why it's blocked | What to do |
|---|---|---|
| **Apply 20260622 migration to production** | Adds 5 columns to production tables. Defaults are safe (`notifications_paused=true`, others NULL). Reversible by `ALTER TABLE ... DROP COLUMN` if needed. But still: your call, your customer's data. | Run `mcp__supabase__apply_migration` with the file when ready. The code already handles pre-migration state gracefully. |
| **Fix Bimini's `customers.full_name` data** | Currently `"Bimini Island Tours"`. Should be Karenda's actual name (`"Karenda Swain-Rolle"` or whatever she prefers). This is production data on Karenda's row — needs your OK. | Confirm the right name, then a one-row `UPDATE customers SET full_name = '...' WHERE id = '653257d9-c0f1-4271-be6d-3e2596fd893e'`. |
| **Populate Bimini's new identity fields** | After migration is applied, the three new columns will exist but be NULL. To actually answer "what's my personal email?" Caye needs the data populated. | A one-row `UPDATE customers SET operator_personal_email = ..., operator_personal_phone = ..., team_notes = ... WHERE id = ...` once you have the values from Karenda. |
| **Onboarding intake / settings panel for new fields** | The spec calls for a UI to collect these going forward so new customers don't end up like Bimini did. Not done — significant UI build, didn't want to rush it during a nap. | Spec'd in receptionist-spec.md Block 1. Pick up there. For now the new fields can be populated via direct SQL. |
| **Deploy to Vercel** | Code changes only take effect after deploy. | When you're ready, `git add / commit / push` and let the existing Vercel pipeline handle it. The hold-ack send path uses production Zoho — first hold after deploy that has `customer_acknowledgement` set will send a real email to a real customer. Watch the logs. |
| **Block 2 remainder (Zoho drafts + stale-hold sweep)** | Larger build. Wanted to ship Block 1 + Q7 first as a self-contained unit. | Resume next session. |
| **Block 3 (shadow operator routing in `enqueueOutbound` / `enqueueHoldPing`)** | Migration adds the columns but `enqueueOutbound` and `enqueueHoldPing` don't yet read them. Currently `notifications_paused=true` default would *do nothing* because nothing checks it. | Wire `loadScheduleConfig` (or similar) to load both fields; gate `enqueueOutbound` on `notifications_paused=false`; use `override_phone` as the destination when set. Half-day build. |

## 🔍 Surprising findings from the data audit

These changed my mental model of the spec — worth knowing:

1. **Bug 2 (read-tool keying mismatch) does not exist.** I queried Bimini's workspace: `workspace_ai_config.workspace_id`, `customers.id`, `connected_accounts.user_id`, `bookings.user_id` are all the same UUID (`653257d9-c0f1-4271-be6d-3e2596fd893e`). 308 bookings, 3 connected accounts. Schema is consistent. The "Caye couldn't access recent customer inquiries" failure must have been something else — a transient tool error, a Claude misinterpretation of empty-but-valid results, or maybe the question hit a tool that doesn't exist by that exact intent. **Needs Vercel log review against the actual conversation transcript to pinpoint.** Logging audit (spec open question 5) is now more important.

2. **Bimini's payment rail is Cash, Zelle, Card** — straight from `business_brief.paymentMethods`. Not WeTravel. This was one of the "ask Karenda" parked questions; turns out the answer was already in onboarding data. **The implication for Q2 (payment loop):** there's no single payment link to send. Receipt-detection across three rails is harder than WeTravel-only. Day-before reminder is now even more decoupled from payment status — Karenda probably can't tell who's paid for a Zelle/Cash booking until the customer arrives. The payment loop may need to stay parked indefinitely; reminders should probably fire based on `booking_date` regardless of payment status, with copy that doesn't presume "you've paid."

3. **`ai_enabled` column truly doesn't exist** on `workspace_ai_config` (verified via `information_schema`). Confirms the BACKLOG bug. The migration noted in `supabase/migrations/20260524_add_ai_enabled_to_workspace_ai_config.sql` either never ran, was rolled back, or wrote to a different column. Worth investigating — but separately from this build.

4. **`business_brief.services` is the live pricing catalog** for Bimini and it's much richer than `service_pricing_tiers`. All five core tours have full per-person + per-couple/family + per-group pricing. The "Specialty Experiences" gap (Beach Experience, Your Way Private) is real and intentional — they're literally "pricing available upon request." So the 2B defer behavior is correct for those, not a catalog bug.

5. **The `business_brief` jsonb is doing a lot of work** — onboarding captures address, tagline, services, hours availability, payment methods, etc. all in there. Worth treating as a first-class source of identity data going forward (which the new prompt does).

## ▶️ Suggested order when you resume

1. **Run the typecheck yourself** and skim the diff to make sure the back-office prompt change reads how you want it to read for Karenda's next chat.
2. **Confirm Karenda's actual personal name** (sounds like Karenda Swain-Rolle from the Compass/pulse files). Update `customers.full_name`.
3. **Apply the migration.** Then populate the three new fields with whatever you know about Karenda + Bimini.
4. **Real test:** Karenda WhatsApps Caye again with the same "who's the owner?" + "show me recent inquiries" questions. Watch Vercel logs for `[caye-agent/execute]` entries to diagnose the data-access failure that wasn't Bug 2.
5. **Then resume building** — Block 2 remainder (Zoho drafts + stale-hold sweep), Block 3 (notification routing), and tighten Block 4 (logging + voice audit).

The spec doc ([receptionist-spec.md](receptionist-spec.md)) is the source of truth. This doc is the diff between spec-when-written and code-as-staged after one nap of work.
