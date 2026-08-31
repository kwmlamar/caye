-- Gmail and other inbound ingestion paths persist customer messages with
-- delivery status `received`. Production's message_delivery_status enum was
-- tightened without preserving that inbound state, causing otherwise-valid
-- Gmail messages to fail at insert time with SQLSTATE 22P02.
--
-- Restore the inbound status explicitly. `IF NOT EXISTS` keeps this migration
-- safe across environments that may already include the value.
alter type public.message_delivery_status
  add value if not exists 'received';
