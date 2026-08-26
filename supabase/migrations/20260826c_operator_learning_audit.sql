-- 2026-08-26 — Operator Learning Router, part 3: operator_learning_audit.
--
-- WHY
-- Today, whether an authorized owner/founder correction becomes durable
-- knowledge depends entirely on whether the back-office LLM chose to call a
-- write tool in the moment, guided only by system-prompt instructions —
-- there is no record of what was said, how it was classified, or why it
-- did or didn't persist. The operator-learning router (this migration's
-- sibling code change) makes that decision deterministic and this table
-- makes it auditable: one row per classification/write decision, whether or
-- not anything was actually written.
--
-- NOT a knowledge store. This table records DECISIONS about the existing
-- authoritative stores (business_facts, service_pricing_tiers,
-- operator_allowlist, service_availability_rules, service_date_overrides);
-- it never itself answers a future "what does the business know" question —
-- that stays exactly where it already lives.
--
-- PII: deliberately minimal. source_excerpt is capped and holds only the
-- operator's own statement (never customer content — customers never reach
-- this pipeline). No separate payload of resolved contact phone numbers is
-- duplicated here beyond what's already inherent in the operator's own
-- words; the authoritative value lives in operator_allowlist, not here.

create table if not exists public.operator_learning_audit (
  id                    bigint generated always as identity primary key,
  workspace_id          uuid not null references public.customers(id) on delete cascade,

  source_operator_id    bigint references public.operator_allowlist(id) on delete set null,
  source_operator_role  text,
  source_message_id     uuid references public.caye_operator_messages(id) on delete set null,
  source_conversation_id text,
  source_excerpt        text not null,

  classifier_version    text not null,
  explicitness          text check (explicitness in ('explicit_statement', 'explicit_correction', 'inferred_from_action', 'ambiguous')),
  scope_kind            text check (scope_kind in ('standing', 'date_scoped', 'customer_scoped', 'one_off', 'ambiguous')),
  scope_target          text check (scope_target in ('workspace', 'service', 'specific_date', 'customer', 'person', 'unknown')),
  risk_level            text check (risk_level in ('low', 'consequential')),
  destination           text check (destination in ('business_fact', 'pricing', 'contact', 'availability_recurring', 'availability_date', 'none')),
  canonical_key         text,

  -- What actually happened.
  decision              text not null check (decision in ('written', 'superseded_and_written', 'candidate', 'no_op', 'rejected', 'error')),
  target_table          text,
  target_record_id      text,
  superseded_record_id  text,
  reason                text not null,

  created_at            timestamptz not null default now()
);

create index if not exists operator_learning_audit_workspace_idx
  on public.operator_learning_audit (workspace_id, created_at desc);

-- Idempotency gate: the router checks this before classifying at all, so a
-- duplicate WhatsApp webhook delivery of the identical inbound message is a
-- cheap lookup, not a second LLM call and a second write attempt.
create index if not exists operator_learning_audit_source_message_idx
  on public.operator_learning_audit (workspace_id, source_message_id)
  where source_message_id is not null;

alter table public.operator_learning_audit enable row level security;

comment on table public.operator_learning_audit is
  'One row per operator-learning classification/write decision — audit trail only, never itself an authoritative knowledge source. See lib/operator-learning-router.ts.';
