-- 2026-08-26 — Owner-attention operator-awareness columns.
--
-- WHY
-- Real production incident (Bimini, Autumn McNeill, 2026-08-26): Mrs. Max
-- actively handled Autumn's booking herself through Caye — pulled the
-- thread, edited and sent the reply, then told Caye directly "we already
-- responded to autumn. she is waiting on the invoice to pay." Nine and a
-- half hours later (deferred past quiet hours), the booking_created
-- trigger fired anyway: "Just booked — Autumn McNeill, ...". Caye had
-- structural proof the operator already knew this exact state and told her
-- again anyway.
--
-- caye_owner_attention already tracks whether CAYE told the operator
-- (notified_fingerprint / last_notified_at / notify_count) and lets a
-- composer see "have I already said this" — but it has no way to record
-- that the OPERATOR demonstrated awareness independently, without Caye
-- ever having said anything. Those are different facts with different
-- provenance and must not be conflated into the same columns (an
-- operator_aware_at that secretly means "Caye pinged them" would make the
-- notified/aware distinction unauditable — see decideOperatorNotification's
-- SUPPRESS_OPERATOR_AWARE outcome and owner-attention.ts's
-- 'alreadyKnownToOperator' delta bucket).
--
-- Three columns, mirroring the shape of the existing notified_fingerprint /
-- last_notified_at / last_notified_summary trio exactly, so the read side
-- (owner-attention.ts) can reuse the identical "does the stamped
-- fingerprint match the current state_fingerprint" comparison it already
-- has for the notified side.
alter table caye_owner_attention
  add column if not exists operator_aware_fingerprint text,
  add column if not exists operator_aware_at timestamptz,
  add column if not exists operator_aware_summary text;

comment on column caye_owner_attention.operator_aware_fingerprint is
  'state_fingerprint value as of the moment the operator demonstrated awareness (e.g. sent an operator-approved reply in the linked conversation) independent of any notification Caye sent. Compared against the live state_fingerprint the same way notified_fingerprint is: equal means nothing has changed since the operator showed they knew.';
comment on column caye_owner_attention.operator_aware_at is
  'When operator_aware_fingerprint was stamped. Distinct from last_notified_at, which only ever means Caye told them.';
comment on column caye_owner_attention.operator_aware_summary is
  'Short, factual note of what evidence established awareness (e.g. "operator sent a customer-facing reply in this conversation") — audit trail for why a notification was suppressed as SUPPRESS_OPERATOR_AWARE.';
