-- Migration: add metadata column to workspace_ai_config for discovery tracking
-- Supabase project: fetsfbdltlxjsomiqvrw
--
-- Adds a JSONB metadata column that stores discovery job state:
--   discovery_status: 'running' | 'done' | 'empty_inbox' | 'extraction_failed' | 'greeting_shown' | 'no_account'
--   discovery_started_at: ISO timestamp
--   discovery_finished_at: ISO timestamp
--   discovery_messages_read: integer count of sent messages analyzed
--   discovery_greeting: the text of Caye's first welcome message (cleared to null once shown)
--
-- To apply: paste into the Supabase SQL editor and run.

ALTER TABLE workspace_ai_config
  ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}';

COMMENT ON COLUMN workspace_ai_config.metadata IS
  'Discovery and configuration state for Caye. Tracks discovery job progress, stores the first greeting message, and other workspace-level flags.';
