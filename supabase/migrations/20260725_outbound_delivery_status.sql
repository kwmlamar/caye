-- Meta's WhatsApp Cloud API sends delivery-status callbacks (sent/delivered/
-- read/failed) on the same webhook as inbound messages, keyed by the
-- message id returned at send time. Both webhook handlers were discarding
-- that payload entirely (app/api/webhooks/whatsapp/route.ts has an explicit
-- "ignore silently" comment; app/api/webhooks/whatsapp-operator/route.ts's
-- processInbound only reads value.messages). Result: caye_outbound_queue's
-- status='sent' only ever meant "Meta's HTTP call succeeded" — never
-- confirmation the operator's phone actually received it. Surfaced while
-- investigating a Karenda/Bimini report of missing WhatsApp messages
-- (2026-07-24/25).
--
-- wa_message_id is populated at send time (lib/whatsapp/outbound.ts already
-- returns it in SendResult, just wasn't being stored). The webhook then
-- matches incoming statuses against it to fill in the rest.

ALTER TABLE caye_outbound_queue
  ADD COLUMN IF NOT EXISTS wa_message_id text,
  ADD COLUMN IF NOT EXISTS wa_delivery_status text CHECK (wa_delivery_status IN (
    'sent', 'delivered', 'read', 'failed'
  )),
  ADD COLUMN IF NOT EXISTS wa_delivery_status_at timestamptz,
  ADD COLUMN IF NOT EXISTS wa_delivery_error text;

CREATE INDEX IF NOT EXISTS caye_outbound_queue_wa_message_id_idx
  ON caye_outbound_queue(wa_message_id)
  WHERE wa_message_id IS NOT NULL;

COMMENT ON COLUMN caye_outbound_queue.wa_delivery_status IS
  'Meta delivery-status callback (distinct from status, which only reflects whether our API call succeeded). Null until a statuses webhook arrives.';

-- Dedup column for the cron-staleness alert (lib/cron-run-log.ts) — avoids
-- re-pinging the founder every minute a cron stays stuck.
ALTER TABLE caye_cron_runs
  ADD COLUMN IF NOT EXISTS last_stale_alert_at timestamptz;
