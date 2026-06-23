# Caye Operating Rules — Issues & Implementation

*Filed 2026-06-23, from Karenda's pricing call. Caye is booking on dates Karenda is closed and on Sundays she handles personally.*

## Root cause (verified in code, not assumed)

Caye's customer-facing quote/booking path is [lib/caye-reply.ts](../lib/caye-reply.ts). Its `check_availability` tool (`checkAvailability`, line ~695) reads **only the `bookings` table for slot capacity**. It has no concept of:

1. **Closures** (Karenda's Dec 23–Jan 3 and Aug 1–9 blackouts)
2. **Weekday routing** (Sundays → Karenda handles personally; Max at church until 11)

### Why Karenda's Zoho closures never reached Caye

Zoho Calendar IS integrated both directions (write via [lib/zoho-calendar.ts](../lib/zoho-calendar.ts), read-back via inbound sync). But [lib/zoho-inbound-sync.ts](../lib/zoho-inbound-sync.ts) **skips all-day events** (documented in its header comment). Multi-day closures are all-day events → they never sync into `bookings` → `check_availability` can't see them. Even if they did sync, they'd look like a normal booking, not a "closed" signal.

## Issue 1 — Caye quotes/books on closed dates
**Severity: high.** A customer can book Aug 5 right now; Karenda is closed Aug 1–9. Caye has no idea.

## Issue 2 — Caye quotes/books on Sundays
**Severity: high.** Karenda explicitly wants all Sunday bookings routed to her (driver Max is at church until 11am; she'd rather handle Sunday timing personally).

## Issue 3 — No place to store either rule
**Severity: structural.** `workspace_ai_config` has no blackout or weekday-routing columns. `availability_slots` table exists but is empty/unused and is the wrong shape (per-service slots, not business-wide closures).

---

## Decision: explicit operating-rules config, not Zoho-derived

Closures and weekday rules are **deterministic business policy**, not calendar guesswork. Storing them as explicit config (vs. inferring from how Karenda happens to title Zoho events) is more reliable, testable, and doesn't pollute the bookings table. Zoho free/busy sync can layer on later as a convenience — out of scope here, and consistent with the AI-OS "defer deep integrations" stance.

## Implementation

1. **Migration** `supabase/migrations/20260623_operating_rules.sql` — add `blackout_dates jsonb` + `owner_only_weekdays smallint[]` to `workspace_ai_config`.
2. **Pure helper** `lib/services/operating-rules.ts` — `evaluateOperatingDate(dateISO, rules)` returns `open` / `closed` / `owner_only`. Pure + unit-tested (recurring-annual wrap-around for the Dec→Jan range is the tricky case).
3. **Wire into** `checkAvailability` — load config, evaluate the date, short-circuit with `closed` / `owner_only` flags in the returned object.
4. **Prompt + tool description** — tell Caye: never `create_booking` on a `closed`/`owner_only` date; `send_reply` warmly + `flag_for_owner_followup`.
5. **Seed Bimini** — `owner_only_weekdays = {0}` (Sunday); blackouts Dec 23–Jan 3 and Aug 1–9.

## Open question for Karenda (flagged, not assumed)

Are the closures **annual** or **one-time**? Seeded as `recurring_annually = true` (Christmas/New Year + a fixed August week read as annual traditions). Schema supports both — flip one boolean per range if she says one-time. **Confirm before relying on it for 2027+.**
