-- 2026-07-06 — persist the clean, plain-language ping summary
--
-- recordEscalation() computes a clean one-line pingSummary at creation time
-- (forced escalations always supply one; LLM-driven ones derive from
-- category + internalContext), but it was only ever used for the immediate
-- first ping and never persisted. The daily escalation-followup cron
-- re-reads the row hours/days later, finds no clean field, and reconstructs
-- one from internal_context — reintroducing the internal classifier jargon
-- (e.g. "Forced escalation — b2b_partnership (inbound classifier — ...)")
-- into owner-facing WhatsApp pings. See
-- app/api/caye/escalation-followup/cron/route.ts.

alter table public.caye_escalations
  add column if not exists ping_summary text;
