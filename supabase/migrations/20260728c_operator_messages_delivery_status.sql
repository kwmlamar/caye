-- 2026-07-28 — surface WhatsApp delivery status inside Caye Direct.
--
-- caye_operator_messages is what actually renders in the founder's Caye
-- Direct dashboard thread, but it only ever recorded that a send was
-- attempted, not whether Meta actually delivered it. Delivery truth lived
-- exclusively in caye_outbound_queue.wa_delivery_status, which only
-- exists for the subset of sends that go through the proactive-ping queue
-- (escalations, digests, etc.) — the far more common synchronous
-- back-office replies (the ones in every Mrs. Max / Karenda thread) had no
-- delivery tracking anywhere.
--
-- wa_delivery_status starts at 'sent' or 'failed' from our own dispatch-time
-- outcome (mirroring caye_outbound_queue's pattern) and gets overwritten to
-- 'delivered'/'read'/'failed' by Meta's async status webhook
-- (handleDeliveryStatus in app/api/webhooks/whatsapp-operator/route.ts),
-- matched by wa_message_id exactly like the queue table already is. Rows
-- with no real WhatsApp send behind them (demo roleplay turns, the web
-- dashboard's own typed messages, log-only escalation closing notes) stay
-- null — there's nothing to report.

alter table public.caye_operator_messages
  add column if not exists wa_delivery_status text,
  add column if not exists wa_delivery_status_at timestamptz,
  add column if not exists wa_delivery_error text;

alter table public.caye_operator_messages
  add constraint caye_operator_messages_wa_delivery_status_check
  check (wa_delivery_status is null or wa_delivery_status in ('sent', 'delivered', 'read', 'failed'));
