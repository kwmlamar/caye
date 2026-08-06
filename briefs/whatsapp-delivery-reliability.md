# Brief: WhatsApp operator-ping delivery reliability

**Status:** spec, not yet implemented
**Written:** 2026-07-27
**Trigger:** Karenda appeared to be receiving Caye's back-office pings in Caye Direct. She was not. Investigation below.

---

## The finding

Over the last 14 days, **93 operator-bound pings were sent. Zero were ever confirmed delivered.** Not one.

```
day          sent  w/ msg_id  timeout  failed  delivered/read
2026-07-27      3          3        0       3       0
2026-07-25      3          0        3       0       0
2026-07-24      2          0        2       0       0
2026-07-22      3          0        3       0       0
2026-07-21     17          0       17       0       0
2026-07-20      1          0        1       0       0
2026-07-19     12          0       12       0       0
2026-07-18      9          0        9       0       0
2026-07-17     12          0       12       0       0
2026-07-16     11          0       11       0       0
2026-07-15      9          0        9       0       0
2026-07-14     11          0       11       0       0
```

Two separate eras, two separate root causes:

**Era 1 (7/14 – 7/25, 90 rows):** `wa_message_id` was never persisted at send time, so
`handleDeliveryStatus`'s `.eq('wa_message_id', s.id)` could never match a row. Meta's status
callbacks were arriving and being silently discarded. All 90 rows were later swept to the
synthetic `timeout` status. **We have no idea whether any of these delivered.** Do not assume
they did.

**Era 2 (7/27, 3 rows):** `wa_message_id` now persists, correlation works — and the instant it
started working, every send came back `failed`:

| Time (UTC) | Kind | Meta error |
|---|---|---|
| 11:01 | `morning_digest` | `131047: Re-engagement message` |
| 18:41 | `urgent_hold` | `131042: Business eligibility payment issue` |
| 19:13 | `urgent_hold` | `131042: Business eligibility payment issue` |

Nobody was told about any of it.

---

## P0 — Human action, not code (blocks everything else)

`131042` is a **WABA-level billing/payment eligibility failure**. It kills every
business-initiated message on the platform number, account-wide. No code change makes a
message deliver while this is live.

**Fix the payment method on the WhatsApp Business Account in Meta Business Manager before
shipping or validating any of the below.** Everything downstream is untestable until then.

---

## P1 — Bug A: the 24h window is tracked per workspace, enforced per recipient

This is what produced `131047` on the morning digest.

- `lib/whatsapp/window.ts` reads `workspace_ai_config.last_whatsapp_inbound_at` — **one
  timestamp per workspace.**
- It's stamped in `app/api/webhooks/whatsapp-operator/route.ts:466` whenever *any* operator
  messages Caye.
- **Meta enforces the customer-service window per recipient phone number.**
- Bimini has three operators: Lamar `+13342219466`, Max, Mrs. Max `+12424422629`.

So: Lamar messages Caye → the workspace-level flag opens → the 11:00 digest addressed to
Mrs. Max takes the free-form path → Meta rejects it, because *Mrs. Max's* own window has been
closed for days.

The free-form path is reachable for `morning_digest` specifically because
`app/api/caye/outbound-worker/route.ts:324` has an explicit escape hatch that runs *before*
the `TEMPLATE_REQUIRED_KINDS` check:

```ts
if (row.kind === 'morning_digest' && windowOpen) { ...sendFreeFormWhatsApp... }
```

### Fix

1. Migration: add `last_inbound_at timestamptz` to `operator_allowlist`.
2. In the operator webhook, stamp that column on the *sending operator's* row, in addition to
   the existing workspace-level write (keep the latter — the config dashboard reads it).
3. Change the signature to `isWhatsAppWindowOpen(workspaceId, phone)` and resolve the window
   from that operator's `last_inbound_at`.
4. **Default closed.** No allowlist row, or a null `last_inbound_at` → return `false` → template
   path. A wrongly-closed window costs nothing (the template still sends); a wrongly-open one
   is a hard delivery failure.
5. Update the one call site (`outbound-worker:316`) to pass the resolved destination phone.
   Note it resolves `phone` *after* the current window check — reorder so the phone is known
   first.

---

## P2 — Bug B: the operator webhook never alerts and never falls back

The customer-facing webhook does this correctly. The operator-facing one does not. That
asymmetry is the entire silent-failure story.

| | Customer webhook | Operator webhook |
|---|---|---|
| file | `app/api/webhooks/whatsapp/route.ts` | `app/api/webhooks/whatsapp-operator/route.ts` |
| handler | `processDeliveryStatuses` (~L444) | `handleDeliveryStatus` (~L194) |
| writes status columns | yes | yes |
| calls `alertFounderOfDeliveryFailure` | **yes** (L470) | **no** |
| fires email fallback | no | no |

Operator pings go over the platform number, so they land on the *operator* webhook — the one
with no alerting. That is why 3 failed sends today produced 0 notifications.

Compounding it: `fireFallback` / `emailFallbackForFailedPing` is only ever called from
`handleResult`, which runs at **dispatch** time. Meta *accepted* all three of today's messages
(`status='sent'`), so `handleResult` took the success branch. The failure only appeared later
via webhook — a stage that has no fallback wiring at all. So `urgent_hold`, which is explicitly
in `EMAIL_FALLBACK_KINDS` precisely because silence there is dangerous, silently did nothing.

### Fix

In `handleDeliveryStatus`, after the column update, add `.select('id, workspace_id, kind')` and:

1. On `s.status === 'failed'` and `OPERATOR_LOGGABLE_KINDS.has(kind)` → call
   `alertFounderOfDeliveryFailure({ ..., stage: 'delivery' })`, mirroring the customer webhook.
2. On `s.status === 'failed'` and `EMAIL_FALLBACK_KINDS.has(kind)` → call
   `emailFallbackForFailedPing`. Delivery-stage failure is exactly the case that fallback was
   built for and has never once fired on.
3. Bump `whatsapp_failure_streak` / `whatsapp_unreachable` on delivery failure too, not just
   dispatch failure. Right now a channel can fail 100% async and the streak stays 0 — which is
   exactly what the live data shows.

**Classify before reacting.** Not every failure means the same thing, and retrying the wrong
class is wasted sends:

| Class | Codes | Response |
|---|---|---|
| Account-fatal | `131042`, `131031`, `133xxx` | Every workspace is down. Alert founder **once globally**, not per workspace/kind. Do not retry. |
| Window / template | `131047`, `132xxx` | Caye's bug. Auto-remediate by re-sending as a template; alert if that also fails. |
| Recipient-specific | `131026`, `470` | That operator's number only → mark unreachable for that workspace, email-fallback. |
| Transient | `131000`, 5xx | Normal retry path. |

Put this in a small `lib/whatsapp/delivery-errors.ts` returning a discriminated union. Keep it
dumb — a code→class lookup with a sane default of "transient", nothing clever.

---

## P3 — Bug C: the alert channel is the broken channel

`alertFounderOfDeliveryFailure` notifies over `sendFreeFormWhatsApp`. When the failure is
`131042` — account-wide — **the alert fails for the identical reason as the thing it's
reporting.** It logs to console and dies. That's the circularity that let 14 days pass.

It's also free-form, so it needs Lamar's *own* 24h window open — which P1 shows we're not
tracking correctly either. Two independent reasons the alert can't get through.

Evidence: `caye_founder_alert_log` contains **4 rows, ever**, all within a 3-second burst on
2026-07-26. Against 93 undelivered pings.

### Fix

Founder alerts must have an escape hatch that does not touch WhatsApp.

- Add `founder_email` to `platform_settings` (currently only `founder_phone` exists).
- On an **account-fatal** class failure, send by email. WhatsApp becomes best-effort/secondary,
  not the carrier of record.
- Keep the existing `caye_founder_alert_log` hourly dedup so a burst is still one alert. For the
  account-fatal class, dedup **globally** rather than per `(workspace, kind)` — one outage
  should be one email, not one per workspace.

**Transport — decide before building.** There is currently *no* platform-level email sender in
the repo: no Resend, no nodemailer, no SMTP. Only per-workspace OAuth mailboxes via
`connected_accounts` (keyed by `user_id`, reached through `getZohoContext`). Two options:

- **(a) Reuse the `TropiTech Outreach` workspace's Zoho** (`7c0537ff-7864-4788-b090-61f561237974`,
  `workspace_kind='internal_sales'`, `hello@getcaye.com`). Zero new dependencies, consistent with
  the no-new-tools rule. **Verify it has a live, non-`needs_reauth` Zoho account first** — if
  the alert path depends on an OAuth token that can silently expire, we've rebuilt the same
  silent-failure trap one layer over.
- **(b) Add Resend.** One dep, one env var, free tier, no OAuth to expire. More robust, small
  tool tax.

Recommend **(b)** despite the tax, *specifically because* this is the alarm-of-last-resort. An
alarm that shares a failure mode with the system it watches isn't an alarm. If (a) is chosen,
the token-expiry case must alert through some third path.

---

## P4 — Backstop: prove the channel works, don't infer it

Everything above is reactive. Add one proactive check so "no news" stops reading as "fine":

- Daily cron (or fold into the existing outbound-worker tick): if a workspace has
  `whatsapp_outbound_enabled=true` and has had **zero** `delivered`/`read` statuses in 48h while
  having sent ≥1 ping, alert. That single check would have caught this on day two.
- Surface last-confirmed-delivery per workspace in the founder dashboard
  (`components/dashboard/founder-home/FounderHome.tsx`). Founder tooling is explicitly
  dual-channel per `Products/Caye/CLAUDE.md`, so a health tile here is in scope — and it's the
  one surface that keeps working when WhatsApp doesn't.
- Treat `timeout` as **unconfirmed, not benign.** The current sweep marks it and moves on. A
  workspace whose pings are *routinely* timing out is a broken workspace.

---

## Explicit non-goals

- Do **not** build a customer-facing delivery/notification-settings surface. Anti-pattern per
  `Products/Caye/CLAUDE.md`. This is founder/admin tooling only.
- Do **not** add a paging/on-call service. Email + the founder dashboard is the ceiling at
  1 paid customer.
- Do **not** retro-repair the 90 `timeout` rows. They're unknowable; leave them as historical
  record.
- Do **not** widen the free-form escape hatch to more kinds to dodge the window bug. Fix the
  window (P1) instead.

---

## Suggested order

1. **P0 billing** — nothing is verifiable before this.
2. **P2 alerting + fallback** — smallest diff, highest value; stops the bleeding immediately.
3. **P3 email escape hatch** — makes P2 trustworthy rather than theatrical.
4. **P1 per-recipient window** — the real fix for `131047`; needs a migration.
5. **P4 backstop + dashboard tile.**

P2 before P1 is deliberate: P1 is the more interesting bug, but P2 is what guarantees we *find
out* next time. Visibility before correctness.

## Acceptance

A deliberately-broken send (bad template param, or a test number with the window closed) must
produce, within one cron tick: a `failed` row with the real Meta code, a founder alert that
arrives **by email**, an email fallback to the operator for `urgent_hold`, and a bumped failure
streak. Verify against `caye_founder_alert_log` — not by reading logs.

---

## P5 — Bug D: a send that's never attempted looks identical to one that worked (fixed 2026-08-05)

Everything above is about sends that were *attempted* and failed. This one is a send that's
never attempted at all — and it slipped past every check above because there's no failure to
alert on.

**Trigger:** `opportunity-scan` and `business-insights` (added 2026-07-28/08-01, after this
brief was written) skip the WhatsApp send outright when the operator's 24h window is closed,
but persisted the turn with `wa_delivery_status: null` — the same value as a demo turn, a
founder-typed dashboard message, or a log-only escalation closing note. Caye Direct's
`DeliveryStatusIcon` renders all of those as "no icon, nothing to see." Confirmed live
2026-08-05: an opportunity-scan recommendation about NBC van capacity sat unsent in Bimini's
thread with no visible warning and no founder alert — indistinguishable from a message that was
actually delivered and just hadn't picked up a read receipt yet.

### Fix (shipped)

1. New `wa_delivery_status` value `'not_sent'` (migration
   `20260805_operator_messages_not_sent_status.sql`) — distinct from null ("no send was ever
   relevant") and `'failed'` ("we tried and Meta rejected it"). Means "a send was relevant here
   and we deliberately chose not to attempt it."
2. `persistAgentTurns` (`lib/caye-operator-messages.ts`) takes an optional `notSentReason` and
   stamps it on the last assistant turn when passed.
3. Both scan crons pass a reason on the window-closed branch and call
   `alertFounderOfDeliveryFailure({ ..., stage: 'skipped' })` — new stage on that function,
   labeled "not sent." Classifies as `transient` by default (no Meta code to extract), which is
   fine: this only changes account_fatal's email escalation, and a closed window never is one.
4. `DeliveryStatusIcon` renders `not_sent` with the same amber warning glyph as `failed`, tooltip
   showing the reason.

### Follow-up (shipped 2026-08-05): notify-only template ping

P1 (per-recipient window tracking, `lib/whatsapp/window.ts`) was already live by the time this
was scoped — it's what correctly identifies the window as closed here, not a gap. What remained
was: a scan recommendation that gets skipped still never reaches the operator by any channel
except the founder alert above and whatever they later see in Caye Direct.

Scoped routing the scan crons through `caye_outbound_queue` for real template fallback and found
it can't ever deliver the actual analysis regardless of architecture — Meta rejects free-form
text outside the 24h window no matter which code path sends it, and no generic template exists
for arbitrary scan content (only `caye_urgent_hold`'s 2-placeholder shape is available, same
`{{1}} needs your call — {{2}}. Tap to see the draft.` copy already reused imperfectly for
`booking_created`/`escalation`/`escalation_followup`).

So the fix is notify-only: `opportunity_scan`/`business_insights` are now `OutboundKind`s
(`lib/whatsapp/outbound.ts`), always template-required
(`app/api/caye/outbound-worker/route.ts`'s `TEMPLATE_REQUIRED_KINDS`), reusing
`caye_urgent_hold`. The window-closed branch in both crons now also calls `enqueueOutbound` right
after the founder alert — a short "Caye has something for you, check Caye Direct" ping goes out
through the real queue (inheriting retries/dead-lettering/delivery correlation), while the actual
write-up stays exactly where it was: the `persistAgentTurns` row, `wa_delivery_status='not_sent'`.

**Known, accepted quirk:** this produces two `caye_operator_messages` rows per skipped scan — the
reasoning-transcript row (no delivery status, has the real content) and a separate notification-
ping row written later by `logOperatorPing`/`operatorPingLogBody` (has a real delivery status,
generic text). They correlate only by proximity in the thread, not by any shared key — `wa_message_id`
isn't known until the queue actually dispatches, well after the transcript row is written.
Documented behavior, not a bug to chase.

Migration: `20260805b_extend_outbound_kind_for_scan_notify.sql` (DB-level `kind` CHECK on
`caye_outbound_queue`, same bug class as `20260626_extend_outbound_kind_for_escalations.sql` —
the TS type and the SQL CHECK have to move together or `enqueueOutbound` fails outright).
