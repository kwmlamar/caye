-- 2026-08-13 — additive columns for the shared operator-notification gate
-- (lib/whatsapp/operator-notification-gate.ts).
--
-- Root cause of the day's incident (Mrs. Max / Bimini got 4 overlapping
-- WhatsApp pings about one Karin Roberts deposit invoice + a content-free
-- "check Caye Direct" scan ping): every autonomous producer decided
-- independently whether to notify the operator, with no shared "is Caye
-- actually blocked on them, or could she finish this herself" signal and no
-- durable link from an attention item back to the specific queue row that
-- notified about it. caye_owner_attention (20260812c) already IS the shared
-- ledger every composer reads/writes — these are the three fields the new
-- gate needs that weren't there yet. No new table: see 20260812c's own
-- comment for why one ledger, not several.

alter table caye_owner_attention
  add column if not exists blocked_on_operator boolean not null default true,
  add column if not exists resolvable_autonomously boolean not null default false,
  add column if not exists last_notification_queue_id uuid,
  add column if not exists pending_notification_queue_id uuid;

comment on column caye_owner_attention.blocked_on_operator is
  'Is Caye actually waiting on the operator to act right now. False means Caye can proceed without them — the gate suppresses operator pings for items where this is false and resolvable_autonomously is true.';
comment on column caye_owner_attention.resolvable_autonomously is
  'Could Caye finish this herself given her current tools/capabilities. When true and blocked_on_operator flips false, the gate resolves the item instead of pinging.';
comment on column caye_owner_attention.last_notification_queue_id is
  'caye_outbound_queue.id of the last notification sent for this item, so the gate can look up wa_delivery_status (read receipts) as a reminder-cadence signal without re-deriving which row it was.';
comment on column caye_owner_attention.pending_notification_queue_id is
  'caye_outbound_queue.id of a notification QUEUED for this item but not yet dispatched — the "notification in flight" lifecycle state between not-notified and notified (2026-08-13, closes the digest/escalation ordering hazard: without this, a composer reading the ledger before the outbound worker''s next tick sees notify_count=0 and independently narrates an item a ping is already on its way for). Cleared by markAttentionNotified once the send is confirmed; loadAttentionDelta also treats a stale pointer (queue row no longer pending — sent/cancelled/failed) as not in flight, so a failed/cancelled ping can never permanently suppress an item.';
