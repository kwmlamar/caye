-- Internal audit/note rows are not customer-facing deliveries. Historically
-- unified_messages forced them into message_delivery_status='sent' because
-- the enum had no non-delivery state, producing rows that simultaneously said
-- is_internal=true and status='sent'. Give internal records a first-class
-- status before the follow-up migration starts enforcing it.
--
-- Kept as its own migration because PostgreSQL requires a newly-added enum
-- value to be committed before it is used by later DML/constraints.
ALTER TYPE public.message_delivery_status ADD VALUE IF NOT EXISTS 'internal';
