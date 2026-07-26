# Owner Trust Pipeline — build spec

Date: 2026-07-26. Origin: Karenda (Bimini) complaint — "I did not get any communications
from Caye yesterday and there were bookings." Investigated live DB + code; decisions
grilled and locked with Lamar. Build order is A then B — do not start B until A ships.

**Status: A1–A4 and B1–B3 all shipped 2026-07-26** (commits af4cf84, 232b416, 5d15a62,
3f06b3a, 390745b, 051407b). One incident along the way, also fixed same day: A3's
founder-alert code had no real dedup and spammed the founder's WhatsApp with a backlog
of stale queue rows — see 3f06b3a and supabase/migrations/20260726c_founder_alert_dedup.sql.

## Confirmed findings (live data, Bimini workspace `653257d9-c0f1-4271-be6d-3e2596fd893e`)

1. **Hold/auto-reply race.** Ashley Kukuczka's inbound (2026-07-26 00:36 UTC) was
   BOTH held (`human_agent_marked_at` 00:38:16.064) and full-auto-replied
   (`caye_auto_*` row, 00:38:16.673 — 0.6s later). One pipeline can't do both — the
   hold branch returns before the send in both `app/api/webhooks/zoho-email/route.ts`
   and `app/api/email/poll/route.ts`. Two processors raced on the same inbound
   (check-then-insert dedupe, no atomic claim). Customer got Caye's reply at 8:38pm
   local, then Max's manual correction (~12:02am, tagged `is_correction`) with
   different pricing. Caye then told Karenda the thread was "held for your attention."
2. **Morning digest dead.** Only `morning_digest` queue row in 4 days is Jul 23 —
   malformed (hold payload under digest kind → Meta 400 `132000` param mismatch),
   status `failed`, failure_count 1, never retried, never alerted. Jul 24/25 digests
   never queued despite 5+ held threads and `digest_days` [1-5]. Root cause of the
   non-enqueue is unconfirmed — verify the cron-job.org registration actually hits
   `/api/caye/morning-digest` at 11:00 UTC and that the deploy timeline covers 7am
   local, before assuming code bug.
3. **Narrative briefing retirement (uncommitted)** removes the only morning message
   Karenda actually received. Its replacement (the count digest) doesn't send (see 2).
4. **Delivery invisible.** All queue rows have `wa_delivery_status: null`. "sent" =
   Meta accepted, not delivered. Urgent pings Jul 25 (helmer.michelle 23:52,
   Sue Guilbert 15:00) show sent; Karenda reports receiving nothing — unprovable
   either way today.
5. **Routine holds silent by design** (`lib/whatsapp/triggers.ts:49-54` gates on
   keyword urgency, `lib/whatsapp/urgency.ts`). Ashley/Sue/Jeff never pinged.
6. **Stale holds rot**: Marissa McGourthy held 17d, nicole silvera 19d, Mark
   Kelleher 7d. Aging list rides only in the digest that doesn't send.
7. **No ping when Caye books future-dated** (`enqueueSameDayBooking` is same-day
   only). Anthony Coll → Sep 6: silent.
8. **Caye misreports state to the owner.** `get_recent_activity`/`get_held_queue`
   presented Ashley as held-awaiting-attention after it had been answered,
   corrected by Max, and released (`human_agent_enabled` now false).

## Workstream A — correctness (ship first)

**A1. Kill the double-processing race.** Atomic claim per inbound message before any
LLM call or send: unique-insert the inbound `channel_message_id` (or a claims table)
and only the winner proceeds; loser exits. Must cover zoho-email webhook, email poll,
and gmail poll paths. Acceptance: replaying the same inbound through both paths
concurrently produces exactly one decision (one hold OR one send), never both.

**A2. Resurrect the morning message = narrative briefing on digest gating (LOCKED).**
One cron: keep `morning-digest`'s gating (7am local via `isDigestHour`, `digest_days`,
quiet hours, per-day idempotency) but the content is `composeMorningBriefing`
(`lib/caye-agent/briefing.ts`) delivered through the back-office operator channel.
The count template (`caye_morning_digest`) survives only as fallback when the
WhatsApp 24h session window is closed. Fix the addressing bug ("Morning, Mrs. Max"
sent into Karenda's thread) as part of this — briefing must resolve the recipient
operator, not the workspace's other owner. Keep the uncommitted retirement of
`app/api/caye/morning-briefing/cron/route.ts`; delete the cron-job.org registration
when convenient.

**A3. Delivery truth.** Consume Meta's message-status webhook into
`caye_outbound_queue.wa_delivery_status{,_at,_error}` (columns exist, nothing writes
them). Failed/undelivered after a grace window → founder alert via admin channel and
retry policy for transient failures. A `failed` queue row must never again sit
silent (Jul 23 digest did). Acceptance: every operator-bound send ends in
delivered/read/failed-with-alert, never permanently "sent".

**A4. Truthful self-report.** `get_held_queue`/`get_recent_activity` must present
current state: a released hold is "answered/resolved", an auto-replied thread is
"replied", a corrected thread is "replied, then Max corrected". Never list a
resolved thread as awaiting attention.

## Workstream B — notification redesign (after A)

All decisions LOCKED with Lamar 2026-07-26:

**B1. Ping every hold in real time.** Remove the routine-urgency gate in
`enqueueHoldPing`; every hold pings the owner immediately, quiet hours defer to the
digest window (existing `nextDigestTime` mechanics). Reuse `caye_urgent_hold`
template (contactName + reason); soften reason copy for routine holds. Keep
idempotency per conversation+timestamp. This fulfils Caye's explicit promise to
Karenda ("I'll call out held items as they come in").

**B2. Ping every booking Caye creates**, any date: "Just booked Anthony Coll —
private charter, Sep 6, 10am." Extend/replace `enqueueSameDayBooking`; reuse the
urgent_hold template until a dedicated template is approved.

**B3. Stale holds nag, never act.** Aging held items lead the morning briefing daily
until resolved, with an offer: "Marissa — 17 days waiting. Want me to take a first
pass?" No auto-release, no founder escalation.

## Out of scope
Customer-side cleanup of Ashley's conflicting replies (owner's call — Lamar to
surface to Karenda), Zoho draft-on-hold flow (`createZohoReplyDraft` still needs its
manual send-vs-draft verification before production wiring).
