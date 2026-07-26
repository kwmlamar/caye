-- alertFounderOfDeliveryFailure (lib/whatsapp/founder-alert.ts) was documented
-- as "bucketed hourly per (workspace, kind)" but never actually checked
-- anything before sending — the bucket was only baked into the WhatsApp
-- idempotency key, which Meta does not dedupe sends on. A burst of stale
-- queue rows for the same workspace/kind (e.g. Bimini escalation_followup,
-- 2026-07-26) fired one real WhatsApp per row instead of one per hour.
-- This table gives the bucket somewhere real to be checked against: insert
-- fails on a repeat key (23505) → skip the send.
create table if not exists caye_founder_alert_log (
  alert_key text primary key,
  created_at timestamptz not null default now()
);
