-- 2026-05-30 — Add sender_attribution column to unified_messages
--
-- BACKGROUND: Sender provenance is currently buried in nested JSONB metadata
-- (metadata.sent_by, metadata.generated_by, metadata.source, plus is_internal
-- as a separate column). Reading "who actually sent this message" requires
-- correlating four fields. The 2026-05-30 Stallings autopsy spent two hours
-- diagnosing a "Caye hallucinated pricing" claim that the metadata clearly
-- disproved — the field just wasn't surfaced cleanly. Surfacing this as a
-- typed column makes the data model legible to humans, dashboards, and agents.
--
-- See also: _Ops/Brain/agent-tone.md (verification discipline note 2026-05-30).
--
-- ENUM-LIKE VALUES (kept as TEXT to allow future additions without migration):
--   customer            — inbound from customer (always sender_type='customer')
--   caye_autopilot      — Caye generated AND autosent without human review
--   caye_held_draft     — Caye generated, held for human review (is_internal=true)
--   human_via_caye      — human approved/wrote and sent through Caye UI
--   human_via_external  — human sent directly via Zoho/Meta/etc., Caye saw via sync
--   system              — automated non-Caye sends (status updates, notifications)

ALTER TABLE unified_messages
  ADD COLUMN IF NOT EXISTS sender_attribution TEXT;

COMMENT ON COLUMN unified_messages.sender_attribution IS
  'Source of truth for who/what produced this message. One of: customer, caye_autopilot, caye_held_draft, human_via_caye, human_via_external, system. Replaces the previous pattern of correlating metadata.sent_by + metadata.generated_by + metadata.source + is_internal.';

-- Backfill from existing metadata.
-- Order matters: more specific rules first.

-- caye_held_draft: Caye-generated and internal-only
UPDATE unified_messages
SET sender_attribution = 'caye_held_draft'
WHERE sender_attribution IS NULL
  AND sender_type = 'business'
  AND is_internal = true
  AND metadata->>'generated_by' = 'caye';

-- caye_autopilot: Caye-generated and actually sent (not internal)
UPDATE unified_messages
SET sender_attribution = 'caye_autopilot'
WHERE sender_attribution IS NULL
  AND sender_type = 'business'
  AND is_internal = false
  AND metadata->>'generated_by' = 'caye';

-- caye_autopilot fallback: email-template auto-replies (sync route flagged is_automated=true)
UPDATE unified_messages
SET sender_attribution = 'caye_autopilot'
WHERE sender_attribution IS NULL
  AND sender_type = 'business'
  AND is_internal = false
  AND (metadata->>'is_automated')::boolean = true;

-- human_via_caye: human sent through the Caye UI (has user_id stamp)
UPDATE unified_messages
SET sender_attribution = 'human_via_caye'
WHERE sender_attribution IS NULL
  AND sender_type = 'business'
  AND is_internal = false
  AND metadata->>'sent_by' = 'human'
  AND metadata->>'user_id' IS NOT NULL;

-- human_via_external: human sent via Zoho/Meta directly, picked up by sync
UPDATE unified_messages
SET sender_attribution = 'human_via_external'
WHERE sender_attribution IS NULL
  AND sender_type = 'business'
  AND is_internal = false
  AND metadata->>'sent_by' = 'human'
  AND (metadata->>'source' = 'zoho_sent' OR metadata->>'user_id' IS NULL);

-- customer: any inbound
UPDATE unified_messages
SET sender_attribution = 'customer'
WHERE sender_attribution IS NULL
  AND sender_type = 'customer';

-- Anything remaining business with no attribution metadata — best guess is human_via_external
-- (likely older messages from before metadata fields were added)
UPDATE unified_messages
SET sender_attribution = 'human_via_external'
WHERE sender_attribution IS NULL
  AND sender_type = 'business';

-- Index for filtering by attribution in dashboard queries
CREATE INDEX IF NOT EXISTS idx_unified_messages_sender_attribution
  ON unified_messages(sender_attribution);
