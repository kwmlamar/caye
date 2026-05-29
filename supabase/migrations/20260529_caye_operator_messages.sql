-- Migration: persist operator→Caye WhatsApp messages for audit/diagnostics.
-- Supabase project: fetsfbdltlxjsomiqvrw
--
-- Per Phase 3 of the WhatsApp-as-primary-interface build. No transcript view
-- in v1 — this is purely a diagnostic surface so Lamar + Karenda can audit
-- what was said when something feels off.

CREATE TABLE IF NOT EXISTS caye_operator_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  wa_message_id text,
  body text NOT NULL,
  intent jsonb,
  related_queue_id uuid REFERENCES caye_outbound_queue(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS caye_operator_messages_workspace_idx
  ON caye_operator_messages(workspace_id, created_at DESC);

-- Best-effort dedup against Meta resending the same inbound webhook.
CREATE UNIQUE INDEX IF NOT EXISTS caye_operator_messages_wa_msg_idx
  ON caye_operator_messages(wa_message_id)
  WHERE wa_message_id IS NOT NULL;

COMMENT ON TABLE caye_operator_messages IS
  'Diagnostic log of operator↔Caye WhatsApp messages. Inbound rows store classified intent for audit.';
