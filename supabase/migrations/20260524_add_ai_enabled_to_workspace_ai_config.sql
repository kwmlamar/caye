-- Migration: add ai_enabled to workspace_ai_config
-- Supabase project: fetsfbdltlxjsomiqvrw
--
-- This adds a workspace-level kill switch for the Caye auto-reply engine.
-- Setting ai_enabled = false pauses AI responses on all channels without
-- disconnecting any connected_accounts (unlike setting is_active = false).
--
-- To apply: paste into the Supabase SQL editor and run, or use `supabase db push`.

ALTER TABLE workspace_ai_config
  ADD COLUMN IF NOT EXISTS ai_enabled boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN workspace_ai_config.ai_enabled IS
  'Master switch for Caye AI auto-replies. false = receive messages but never generate or send automated replies.';
