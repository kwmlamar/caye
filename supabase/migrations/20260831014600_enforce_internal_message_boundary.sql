-- Internal unified-message rows are audit/state records, never deliveries.
-- The preceding migration adds message_delivery_status='internal' in its own
-- transaction because PostgreSQL cannot use a newly-added enum value until
-- that transaction commits.

UPDATE public.unified_messages
SET status = 'internal'::public.message_delivery_status
WHERE is_internal = true
  AND status::text <> 'internal';

CREATE OR REPLACE FUNCTION public.enforce_unified_message_audience_boundary()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Internal rows are normalized at the persistence boundary even if an older
  -- application writer still supplies status='sent'. They can never represent
  -- an external delivery in the canonical ledger.
  IF NEW.is_internal = true THEN
    NEW.status := 'internal'::public.message_delivery_status;
    NEW.metadata := COALESCE(NEW.metadata, '{}'::jsonb)
      || jsonb_build_object('audience', 'internal');
    RETURN NEW;
  END IF;

  -- Conversely, an external/customer-visible row may never claim the internal
  -- status. Failing closed here is safer than silently upgrading it to sent.
  IF NEW.status::text = 'internal' THEN
    RAISE EXCEPTION 'non-internal unified message cannot use internal delivery status';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS unified_messages_audience_boundary ON public.unified_messages;
CREATE TRIGGER unified_messages_audience_boundary
BEFORE INSERT OR UPDATE OF is_internal, status, metadata
ON public.unified_messages
FOR EACH ROW
EXECUTE FUNCTION public.enforce_unified_message_audience_boundary();

ALTER TABLE public.unified_messages
  DROP CONSTRAINT IF EXISTS unified_messages_internal_delivery_boundary;

ALTER TABLE public.unified_messages
  ADD CONSTRAINT unified_messages_internal_delivery_boundary
  CHECK (
    (is_internal = true AND status::text = 'internal')
    OR
    (is_internal = false AND status::text <> 'internal')
  );

COMMENT ON CONSTRAINT unified_messages_internal_delivery_boundary
ON public.unified_messages IS
  'Internal notes/hold notices must use delivery status internal; customer-facing messages may never use internal status.';
