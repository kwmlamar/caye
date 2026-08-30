-- Persist the latest deterministic interruption-policy verdict on the
-- existing owner-attention ledger. This deliberately extends the canonical
-- attention row instead of creating a parallel alert/audit table.

alter table public.caye_owner_attention
  add column if not exists last_policy_decision jsonb,
  add column if not exists last_policy_decided_at timestamptz;

comment on column public.caye_owner_attention.last_policy_decision is
  'Latest deterministic interruption-policy audit envelope for this attention subject: action, bypass flags, reason codes, and evaluated dimensions (urgency, importance, confidence, change, awareness, authority, cooldown, budget, and consequences of waiting). Advisory/audit state only; authority remains enforced by the existing action gates.';

comment on column public.caye_owner_attention.last_policy_decided_at is
  'When last_policy_decision was evaluated. Not part of the subject state fingerprint and must never itself re-earn attention.';
