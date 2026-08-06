-- 2026-08-05 — distinguish "never attempted" sends from "no send context at all".
--
-- The scan crons (opportunity-scan, business-insights) skip sending entirely
-- when the operator's 24h WhatsApp window is closed, but persisted those
-- turns with wa_delivery_status left null — identical to demo/founder-typed
-- rows that were never meant to go out over WhatsApp at all. Caye Direct's
-- DeliveryStatusIcon renders both as "no icon", so a scan recommendation
-- that never reached the operator looked exactly like the founder's own
-- read-only tooling. Confirmed live 2026-08-05: an opportunity-scan
-- recommendation about NBC van capacity sat unsent with no visible
-- indication and no founder alert. See briefs/whatsapp-delivery-reliability.md.
--
-- 'not_sent' marks "we chose not to attempt a real WhatsApp send" distinct
-- from null ("no send was ever relevant here") and 'failed' ("we tried and
-- Meta rejected it").

alter table public.caye_operator_messages
  drop constraint if exists caye_operator_messages_wa_delivery_status_check;

alter table public.caye_operator_messages
  add constraint caye_operator_messages_wa_delivery_status_check
  check (wa_delivery_status is null or wa_delivery_status in ('sent', 'delivered', 'read', 'failed', 'not_sent'));
