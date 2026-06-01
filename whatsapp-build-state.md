---
status: in progress — waiting 24h on new Caye WABA verification
last_updated: 2026-05-28
next_check: 2026-05-29 (24h after WABA creation)
---

# Caye-to-Operator WhatsApp Messaging — Build State

Pick up here tomorrow. Strategic context lives in [STATE.md](STATE.md); this file is the granular technical state of the WhatsApp-as-primary-interface feature build.

## TL;DR — where we are right now

- **Backend Phases 1 + 2 shipped and verified.** DB schema applied, outbound infrastructure in code, system user token in env, Meta Graph API access confirmed.
- **Blocked for ~24h** waiting on the brand-new "Caye" WABA to clear Meta's verification window.
- **Tomorrow morning's job:** check WABA status → update env vars to point at the new Caye WABA → submit 5 templates → smoke test end-to-end → start Phase 3 (inbound webhook + intents).

## What shipped today (code)

**Phase 1 — DB schema** (`supabase/migrations/20260528_caye_whatsapp_outbound.sql`)
- Applied to production project `fetsfbdltlxjsomiqvrw`
- 11 new columns on `workspace_ai_config` (flag, operator phone, quiet hours, mute, failure tracking)
- `caye_outbound_queue` table (idempotency_key UNIQUE, status enum, scheduled_for index)
- `whatsapp_templates` registry seeded with 5 rows (status `pending`)

**Phase 2 — Outbound infrastructure**
- `lib/whatsapp/outbound.ts` — `sendFreeFormWhatsApp` + `sendTemplateWhatsApp` against Meta Cloud API
- `lib/whatsapp/window.ts` — 23h safety-margin window check
- `lib/whatsapp/email-fallback.ts` — Zoho-Mail fallback for urgent kinds
- `app/api/caye/outbound-worker/route.ts` — cron-secured queue worker with check-before-send, 1-retry, streak tracking
- Shared `enqueueOutbound` helper for upcoming trigger sites

## Env vars status

In `sandbox/caye/.env.local`:

```
CAYE_PLATFORM_WHATSAPP_PHONE_NUMBER_ID=1032942116571609   # OLD Tropichat phone, ON_PREMISE API
CAYE_PLATFORM_WHATSAPP_ACCESS_TOKEN=EAA... (set, working) # System user 'caye-system' token
CAYE_PLATFORM_WHATSAPP_BUSINESS_ACCOUNT_ID=733428696519585 # OLD Tropichat WABA
```

**Token is verified working** — `GET /me` returns `caye-system` (id `122097947535347538`), token has Full Control on the WABA.

**TOMORROW: replace WABA ID** with the new Caye WABA ID once verification clears. Phone number ID also probably needs replacing — the new Caye WABA needs a phone number attached (may have to add one).

Also still **not in Vercel env** — local-only right now. Push to Vercel tomorrow.

## DB state for TropiTech workspace (test workspace)

- `workspace_ai_config.whatsapp_outbound_enabled = true`
- `workspace_ai_config.operator_whatsapp_number = '+13342219466'` (Lamar's personal)
- `workspace_ai_config.operator_whatsapp_verified_at = now()`
- Quiet hours default: `21:00–07:00` (workspace TZ: `America/Chicago`)
- Failure state clean

Ready to receive smoke test queue rows the moment env is pointed at a working WABA.

## The Meta-side mess and how it resolved

Today involved a long Meta admin slog. Final state:

### Old Tropichat WABA — keep for reference, don't use for v1
- WABA ID: `733428696519585`
- Phone: `+1 334-913-0982`, phone number ID `1032942116571609`
- Display name: `Tropichat` (Connected)
- **Platform type: ON_PREMISE** (legacy, can't use Cloud API endpoints with it)
- Currently has webhook pointed at `https://www.tropichat.chat/api/webhooks/whatsapp` (existing guest-side wiring, leave alone)
- Originally owned by Lamar Sineus portfolio, moved to TropiTech Solutions via Meta's "Link a WhatsApp business account" flow earlier today

### New Caye WABA — this is v1's actual platform sender
- **WABA ID: `1482716173600181`**
- Owned by: TropiTech Solutions
- Business name: TropiTech Solutions
- Business verification: **Verified** ✓ (huge — unlocks templates faster + higher conversation limits)
- Account status: Approved
- Time Zone: America/Chicago
- **24-hour waiting period before active** (started ~late afternoon 2026-05-28)
- No phone number attached yet — need to add one tomorrow as part of activation

### Two-WABA setup
Pragmatic: don't migrate Tropichat. Use it for whatever it's currently wired into (guest-side); use new Caye WABA for the new operator-direction feature. Two WABAs in one BSP account is fine.

### Strategic find: TropiTech Solutions portfolio is a Meta BSP (Tech Provider)
Logged in [_Ops/Brain/decisions-log.md](../../_Ops/Brain/decisions-log.md). Means future pilots can be onboarded via Embedded Signup instead of doing their own Meta setup. Not for v1 but huge for the agent-not-app thesis.

### WABA clutter to clean up later
TropiTech Solutions partner overview shows 6+ WABAs:
- Tropichat (Mar 10, 2026, 1 phone) — keep, guest-side use
- Caye (today, 0 phone numbers) — the new one, becomes platform sender
- TropiChat × 3 (Apr 9, 0 phones each) — failed setup attempts, delete
- Test WhatsApp Business Account (Feb 18, 1 phone) — leftover prototype, delete

Cleanup is non-urgent. Park it.

## Tomorrow morning's task list (in order)

1. **Check the new Caye WABA's status** in WhatsApp Manager — TropiTech Solutions portfolio → WhatsApp accounts → Caye. Confirm "24h waiting" has cleared and the account is active for Cloud API.

2. **Add a phone number to the Caye WABA.** The new WABA was created without a phone — need to either port the existing `+1 334-913-0982` from Tropichat (probably not, since that's still on On-Premise) or add a new number. Cheapest: get a new US virtual number via Twilio or similar.
   - **Important consideration:** if you add a brand-new number, Karenda's WhatsApp won't have any 24h-window with it yet, so initial sends require templates. That's fine — we have 5 templates ready to submit.

3. **Update env vars** in `.env.local` AND Vercel env:
   ```
   CAYE_PLATFORM_WHATSAPP_PHONE_NUMBER_ID=<new phone number ID from Caye WABA>
   CAYE_PLATFORM_WHATSAPP_BUSINESS_ACCOUNT_ID=1482716173600181
   ```
   Token stays the same (already has Full Control on the WABA via system user).

4. **Re-verify token + new WABA** via Graph API:
   ```bash
   curl -s "https://graph.facebook.com/v18.0/1482716173600181?access_token=$TOKEN" | jq
   ```
   Look for `platform_type: CLOUD_API` (not ON_PREMISE) — this is the gate.

5. **Submit 5 templates** programmatically against the new Caye WABA. Specs in [STATE.md](STATE.md) under "Live" section but here they are:
   - `caye_otp` (authentication) — `Your Caye code: {{1}}. Don't share it.`
   - `caye_welcome` (utility) — `Hey {{1}} — Caye here. I'll DM you when something needs your call. You can reply to me normally. Reply 'help' anytime.`
   - `caye_morning_digest` (utility) — `Morning, {{1}}. {{2}} held for you, {{3}} bookings today. Reply 'show' for details.`
   - `caye_urgent_hold` (utility) — `{{1}} needs your call — {{2}}. Tap to see the draft.`
   - `caye_auth_failure` (utility) — `Heads up — {{1}} disconnected. Tap to reconnect: {{2}}.`
   
   When approved, also update the Supabase `whatsapp_templates` rows: set `status='approved'`, write `meta_template_id`.

6. **Add Lamar's personal number `+13342219466` as a test recipient** on the new Caye WABA (WhatsApp Manager → Phone Numbers → click number → API Setup → Add recipient → verify OTP).

7. **Smoke test:** insert one `caye_outbound_queue` row of kind `ack` pointed at TropiTech workspace. Cron worker should pick it up within ~1 min and send to `+13342219466`. Verify queue row flips `pending → sent` + message arrives on Lamar's phone.

8. **Set up vercel.json cron entry** if not done:
   ```json
   { "crons": [{ "path": "/api/caye/outbound-worker", "schedule": "* * * * *" }] }
   ```

9. **Once smoke test passes:** start Phase 3 — write Antigravity/Claude brief for inbound webhook + intent classifier + 8 action handlers. Or use the original WhatsApp brief from today's grilling session as-is — it covers Phase 3 already.

## Phase 3-6 still outstanding (Claude work, ~1-2 days)

- **Phase 3:** inbound webhook + intent classifier + 8 action handlers (`send`, `skip`, `edit`, `handled`, `query`, `mute`, `unmute`, `multi`)
- **Phase 4:** setup flow — add "Share your WhatsApp with Caye" as first checklist item, OTP send + verify, welcome ping on completion
- **Phase 5:** trigger wiring — extend `caye-reply.ts` decision with `urgency`, queue triggers from 5 webhook handlers, morning digest cron, race-aware ping suppression
- **Phase 6:** dashboard surfaces — realtime subscription, "Caye also pinged you on WhatsApp" indicator, failure banners, activity log, mute control in settings

Full design captured in today's grilling session (13 decisions locked). Brief was written and is the source of truth for Phase 3-6.

## Unresolved questions parked for later

- **WhatsApp display name change Tropichat → Caye.** The OLD Tropichat WABA's display name Edit was locked earlier today; portfolio move may have unlocked it. But it doesn't matter as much now — new WABA *is* called Caye at the WABA level, so the display name issue is moot if we're using the new WABA for outbound. Tropichat WABA's display name can stay `Tropichat` indefinitely since it's only for the existing guest-side webhook.
- **`getcaye.com` defensive WHOIS check** — still on the punch list, $10–15/yr insurance against squatters.
- **Settings as edit surface for inferred services/pricing/hours** — backlog item from earlier in the day, separate from WhatsApp.
- **Discovery progress pill + realtime subscription** — backlog item, polls once on mount today.

## Karenda status

Day 4 of 30-day prove-value clock (started 2026-05-24). Background mode — no nudges to her. Caye is running on her workspace via email pipeline; WhatsApp messaging won't be enabled for her until after TropiTech dogfood passes (Phase 13 of the rollout plan).

See [Clients/bimini-island-tours.md](../../Clients/bimini-island-tours.md) for her pulse.
