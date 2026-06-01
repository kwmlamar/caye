---
status: planned, not started
created: 2026-05-28
trigger: when Karenda's 30-day prove-value clock is past (after ~2026-06-23) AND no active customer issues
---

# Caye — DB refactor plan

The current Supabase schema has accumulated technical debt from two distinct prototype eras. None of it is urgent — the product works — but every new query has to navigate the chaos, and that tax compounds. This plan captures the cleanup so we don't lose track and so it can be tackled deliberately, not reactively.

**Do not start this while Karenda is in her prove-value window.** The risk of a botched migration breaking her account outweighs the cleanliness payoff. Earliest start: late June 2026.

## The two underlying problems

### 1. Workspace identity naming chaos
Three different names for the same conceptual thing (the workspace, which the system calls a "customer"):

| Column name | Tables using it (partial list) |
|---|---|
| `workspace_id` | caye_threads, standing_rules, workspace_ai_config, workspace_members, email_templates |
| `customer_id` | automation_rules, contacts, conversations, intake_configs, intake_sessions, intake_followups, message_templates, messages, notifications, push_subscriptions, tags, usage_tracking, unified_conversations |
| `user_id` | ai_assistant_logs, booking_services, bookings, connected_accounts, meta_connections (and `user_id` sometimes means the workspace, sometimes the auth.uid() — depending on table) |

The actual table that holds workspaces is named `customers`, not `workspaces`. That's because the original schema was built around tour-operator-as-customer thinking before the multi-workspace generalization.

### 2. Two parallel schemas for the same conceptual data

| Old (early-2026 prototype era) | New (current production) |
|---|---|
| `conversations` | `unified_conversations` |
| `messages` | `unified_messages` |
| `contacts` | — (still in use, no rename yet) |
| `bookings` | — (still in use) |
| `booking_services` | — (still in use) |
| `tags` | — (still in use) |

The "old" conversation + messages tables are mostly dead but still have writes happening in some code paths. The contacts/bookings/booking_services tables are still load-bearing in current code, just with confusing naming.

## Proposed sequence

### Phase 1 — Inventory writes to legacy tables (2 hours, no risk)
- `grep` the codebase for `.from('conversations')`, `.from('messages')`, etc. — find every write site.
- For each, decide: is this write still needed, or is it a legacy carryover that should redirect to the unified table?
- Output: a list of code paths to migrate before any table renames.

### Phase 2 — Migrate live writes off legacy tables (1 day, low risk)
- For each legacy write path, either redirect to the unified table or remove the write entirely.
- Run for ~1 week and verify the legacy tables stop accumulating new rows.

### Phase 3 — Soft-deprecate legacy tables (1 hour, no risk)
- Rename: `conversations` → `_legacy_conversations_2026q1`, `messages` → `_legacy_messages_2026q1`.
- Don't drop yet. Keeping them prefixed-with-underscore signals "do not query" without losing data.
- If nothing breaks for ~2 weeks, drop them.

### Phase 4 — Workspace column naming convergence (1 day, MEDIUM risk)
This is the riskiest phase because it touches FK columns on many tables.

- New convention: `workspace_id` everywhere a workspace is referenced. `user_id` reserved exclusively for `auth.uid()` references.
- Migration order (alphabetical by table to enable per-table rollback):
  - `automation_rules.customer_id` → `workspace_id`
  - `booking_services.user_id` → `workspace_id`
  - `bookings.user_id` → `workspace_id`
  - `contacts.customer_id` → `workspace_id`
  - `intake_configs.customer_id` → `workspace_id`
  - ...etc for the ~15 tables
- For each rename: ALTER TABLE add new column, backfill from old, add NOT NULL constraint, drop old column. Multiple-step migration per column.
- Update every codebase reference. Use TypeScript types as the safety net (generated types should fail compilation if a column doesn't exist).

### Phase 5 — Rename `customers` → `workspaces` (2 hours, LOW risk if Phase 4 is clean)
- Final rename. Everything is consistent: `workspaces` is the table, `workspace_id` is the FK column everywhere.
- Update generated types. Update any remaining string references.

### Phase 6 — Cleanup orphan tables (open question)
Audit what other tables may also be dead carryover:
- `tags` — when is this used? Caye doesn't reference tags in the chat or hold flows.
- `automation_rules`, `standing_rules` — two separate tables; do they overlap?
- `intake_configs` vs `intake_sessions` vs `intake_followups` — three tables for the form-intake flow; could potentially collapse.

## Decision log for the eventual refactor

When the work starts, capture decisions in [_Ops/Brain/decisions-log.md](../../_Ops/Brain/decisions-log.md) — particularly any cases where the "obvious" rename has a non-obvious blocker (e.g. an external integration that hardcodes a column name).

## What this is NOT

- Not a rewrite. The application logic stays the same. This is column renames and table cleanup.
- Not a Supabase platform migration. Staying on Supabase.
- Not an opportunity to introduce a new ORM, change the auth model, or restructure RLS policies. Surgical scope.

## Reasons to delay further
- Karenda's prove-value clock is still active.
- A new pilot is in active onboarding.
- The codebase is mid-feature on something load-bearing.

## Reasons to accelerate
- A real bug surfaces caused by the schema chaos (e.g. a query joins on the wrong column and returns cross-workspace data).
- A new contributor / agent has to learn the schema and the naming chaos is the bottleneck.
- A second product (TropiPay, TropiPunch) needs to be added to the same DB and the workspace concept needs to be cleaner first.
