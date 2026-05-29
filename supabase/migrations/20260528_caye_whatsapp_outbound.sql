-- Migration: Caye WhatsApp-as-primary-interface (outbound + inbound to operator)
-- Supabase project: fetsfbdltlxjsomiqvrw
--
-- Adds per-workspace operator WhatsApp configuration, an outbound message queue
-- (for real-time + scheduled dispatch with retry/idempotency), and a registry of
-- approved Meta templates synced from the WhatsApp Business Manager.
--
-- Per the build plan (Phase 1), all rows are workspace-scoped via customers(id).
-- The outbound worker checks workspace flags before sending (check-before-send).

-- ---------------------------------------------------------------------------
-- 1. Workspace-level operator WhatsApp config (extends workspace_ai_config)
-- ---------------------------------------------------------------------------

ALTER TABLE workspace_ai_config
  ADD COLUMN IF NOT EXISTS whatsapp_outbound_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS operator_whatsapp_number text,
  ADD COLUMN IF NOT EXISTS operator_whatsapp_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS whatsapp_failure_streak int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS whatsapp_unreachable boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS whatsapp_blocked boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS whatsapp_quiet_hours_start time NOT NULL DEFAULT '21:00',
  ADD COLUMN IF NOT EXISTS whatsapp_quiet_hours_end time NOT NULL DEFAULT '07:00',
  ADD COLUMN IF NOT EXISTS whatsapp_muted_until timestamptz,
  ADD COLUMN IF NOT EXISTS last_whatsapp_inbound_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_whatsapp_outbound_status text;

COMMENT ON COLUMN workspace_ai_config.whatsapp_outbound_enabled IS
  'Per-workspace feature flag for Caye→operator WhatsApp messaging. Default off; admin-controlled in v1.';
COMMENT ON COLUMN workspace_ai_config.operator_whatsapp_number IS
  'Operator personal WhatsApp number in E.164 format (e.g. +12423456789). Set during OTP verification.';
COMMENT ON COLUMN workspace_ai_config.last_whatsapp_inbound_at IS
  'Timestamp of operator''s most recent inbound WhatsApp message. Used to gate free-form vs template sends (24h Meta window).';

-- Fast lookup of an inbound operator reply → workspace.
CREATE UNIQUE INDEX IF NOT EXISTS workspace_ai_config_operator_whatsapp_number_idx
  ON workspace_ai_config(operator_whatsapp_number)
  WHERE operator_whatsapp_number IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Outbound queue
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS caye_outbound_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN (
    'urgent_hold', 'same_day_booking', 'auth_failure',
    'morning_digest', 'welcome', 'otp', 'ack'
  )),
  conversation_id uuid REFERENCES unified_conversations(id) ON DELETE SET NULL,
  payload jsonb NOT NULL,
  scheduled_for timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'sent', 'failed', 'cancelled', 'dead_letter'
  )),
  failure_count int NOT NULL DEFAULT 0,
  last_error text,
  idempotency_key text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS caye_outbound_queue_pending_idx
  ON caye_outbound_queue(scheduled_for)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS caye_outbound_queue_workspace_idx
  ON caye_outbound_queue(workspace_id, created_at DESC);

COMMENT ON TABLE caye_outbound_queue IS
  'Queue of WhatsApp messages Caye intends to send to the workspace operator. Worker polls pending rows whose scheduled_for has passed and dispatches them.';

-- ---------------------------------------------------------------------------
-- 3. Template registry (mirrors Meta-approved templates)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS whatsapp_templates (
  name text PRIMARY KEY,
  category text NOT NULL CHECK (category IN ('authentication', 'utility', 'marketing')),
  language text NOT NULL DEFAULT 'en',
  body_template text NOT NULL,
  placeholder_count int NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  meta_template_id text,
  last_synced_at timestamptz DEFAULT now()
);

COMMENT ON TABLE whatsapp_templates IS
  'Local registry of WhatsApp Business templates. Seeded from Meta after approval. The worker checks status=approved before sending a template.';

-- Seed the five templates listed in Phase 0 (status=pending until Meta approves).
INSERT INTO whatsapp_templates (name, category, body_template, placeholder_count, status)
VALUES
  ('caye_otp', 'authentication', 'Your Caye code: {{1}}. Don''t share it.', 1, 'pending'),
  ('caye_welcome', 'utility', 'Hey {{1}} — Caye here. I''ll DM you when something needs your call. You can reply to me normally. Reply ''help'' anytime.', 1, 'pending'),
  ('caye_morning_digest', 'utility', 'Morning, {{1}}. {{2}} held for you, {{3}} bookings today. Reply ''show'' for details.', 3, 'pending'),
  ('caye_urgent_hold', 'utility', '{{1}} needs your call — {{2}}. Tap to see the draft.', 2, 'pending'),
  ('caye_auth_failure', 'utility', 'Heads up — {{1}} disconnected. Tap to reconnect: {{2}}.', 2, 'pending')
ON CONFLICT (name) DO NOTHING;
