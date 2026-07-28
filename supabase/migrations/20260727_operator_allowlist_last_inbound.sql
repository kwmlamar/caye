-- 2026-07-27 — per-operator last-inbound tracking (whatsapp-delivery-reliability)
--
-- Meta enforces the 24h customer-service window PER RECIPIENT PHONE NUMBER.
-- isWhatsAppWindowOpen (lib/whatsapp/window.ts) was checking a single
-- workspace-level workspace_ai_config.last_whatsapp_inbound_at, stamped
-- whenever ANY operator on the workspace messaged Caye. A workspace with
-- multiple operators (e.g. Bimini: Lamar, Max, Mrs. Max) could have one
-- operator's message open the "window" for all of them, letting a
-- free-form send through to an operator whose own window had actually
-- been closed for days — Meta then rejects it with 131047. Confirmed live
-- 2026-07-27: Bimini's 11:00 morning_digest, addressed to Mrs. Max, took
-- the free-form path because Lamar had messaged Caye recently, and failed
-- with exactly that error. See briefs/whatsapp-delivery-reliability.md.
--
-- last_inbound_at defaults to null (window closed) for every existing row
-- — deliberately fails closed. A wrongly-closed window just means one more
-- send takes the template path (harmless); a wrongly-open one is a hard
-- delivery failure against a real operator's phone.

alter table public.operator_allowlist
  add column if not exists last_inbound_at timestamptz;

comment on column public.operator_allowlist.last_inbound_at is
  'Stamped on every inbound WhatsApp message from this specific phone. Drives the per-recipient 24h free-form window check in lib/whatsapp/window.ts — distinct from workspace_ai_config.last_whatsapp_inbound_at, which is workspace-wide and kept only for the config dashboard.';
