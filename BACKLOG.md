---
last_updated: 2026-05-26
---

# Caye — Deferred Work

Things we've discussed and want to build, but not now. STATE.md is what's live + actively next. This is the parking lot.

---

## Unified contact per person (across channels)

**Problem**: Same human appears as multiple rows in Contacts (e.g. "Lamar Sineus" has separate rows for Messenger, WhatsApp, Instagram, email). Identity doesn't transfer across Meta's PSIDs / WA phone / IG ID / email.

**Approach** (Option A from 2026-05-23 design discussion):
- Add `person_id UUID` nullable column to `contacts`. NULL = standalone; same UUID = same person.
- **Auto-merge** on contact creation (conservative — false positives are bad):
  - Exact email match → link
  - Normalized phone match (strip `+`, spaces, country code variants) → link
  - **Never** auto-link on name alone
- **UI** changes in Contacts:
  - List groups rows by `person_id` (fallback: contact id when null)
  - One row per person, channel icons in priority order, summed message counts
  - Detail panel: merged identity header, section per channel with that channel's thread history
  - Actions: "Merge with…" picker, "Split" to undo a merge

**Effort**: ~half a day. Schema migration is trivial; the merged detail panel is the biggest piece. Ship grouped list + auto-merge first, refine detail panel after.

**Risk**: Merging the wrong two people. Keep "Split" easy and never merge silently — always log it visibly so the user can review.

---

## Services management (catalog + Caye awareness)

**Problem**: The `booking_services` table exists and the BookingModal has a service dropdown that works, but there's nowhere in the UI to create/edit services. And Caye has no concept of "the customer is asking about the snorkel tour" — she just sees raw text.

**Two parts, can ship independently:**

### Part A — Settings UI for services
- New panel under Settings → "Services" (or under Calendar settings)
- Table view: name, duration, capacity, price, color, active toggle
- Add / Edit / Soft-delete (set `active=false`)
- Reads/writes `booking_services` directly via the existing Supabase client

### Part B — Caye learns the service catalog
- When generating replies / making booking decisions, inject the workspace's active services list into the system prompt
- Caye can match customer requests against service names + descriptions
- For chat-driven bookings (workstream 2), Caye picks the right `service_id` based on what the customer asked for

**Effort**: Part A is ~2 hrs. Part B is ~1 hr (just a system-prompt enrichment), but only valuable once chat-driven bookings exist (workstream 2 of calendar plan).

**Sequence**: build Part A first whenever services need editing in the UI; bundle Part B into calendar workstream 2 so it lands at the same time as chat-driven bookings.

---

## Email-pipeline cleanups deferred from 2026-05-26 session

Surfaced while fixing the Kelsey Tonner mis-reply / silent-poll bug. None blocking, but each will bite eventually.

### `ai_enabled` ghost-column bug
`app/api/email/poll/route.ts` reads `aiConfig?.ai_enabled === false` to gate the AI loop, but the column doesn't exist on `workspace_ai_config`. The check is permanently false, so the kill switch silently doesn't work. Karenda has no way to turn Caye off via config.
**Fix:** either add the column + an "AI replies on/off" toggle in the dashboard, or remove the check and rely on `connected_accounts.is_active` instead. Decide before Karenda asks for a pause button — not after.

### Payment-receipt subject pre-filter is wrong
The receipt handler added 2026-05-26 only triggers on subjects matching `/RECEIPT PAGE/i`, but the real ChargeAnywhere receipts arrive with subject literal `"Receipt"`. The "RECEIPT PAGE" string lives in the body. Current behavior: receipts fall through to the normal AI path and get treated as regular email.
**Fix:** detect by sender (`noreply@chargeanywhere.com`) + body markers (`Response:` + `ApprovalCode:` + `Customer Name:`). About 4 lines. Held for a separate commit after the bigger persona/scope work.

### `tool_choice: 'any'` forces a reply or a hold every turn
`generateCayeAutoReply` uses `tool_choice: { type: 'any' }`, so Claude is required to call a tool every round. There's no "silence" path — even when the right answer is "do nothing," it has to pick send_reply or hold_for_human. The scope rules added 2026-05-26 push it toward hold, but loosening to `'auto'` would let the model just not engage.
**Risk:** could regress booking flows where forcing a tool call is what makes Caye reliably terminate. Test against the existing booking thread regression set before changing.
**Sequence:** revisit after watching the new hold-heavy behavior live for a week with Karenda — if she's drowning in held items that should be silent, this becomes the lever.

### Prompt tuning round 2
The current system prompt for Bimini is good but written before the scope/identity rules were added. Worth a pass once we see how Caye behaves with the new guards in place — likely small tweaks to make the Karenda voice come through more clearly. Don't tune blind; tune by reading 10 actual outbound replies in the inbox.

### Voice profile schema mismatch + not passed on email
`customers.ai_voice_profile` stores `{tone, responseLength, sampleReply, signatureOpener}` but `lib/voice-profile.ts` expects `{formality_level, writing_style, common_phrases, greeting_style, signoff_style, tone_notes}`. Two different shapes. Email poll route never passes a voice profile to `generateCayeAutoReply` regardless. Either delete the half-wired path or finish it — pick one before adding more voice features.
