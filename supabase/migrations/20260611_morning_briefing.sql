-- Per-workspace morning briefing schedule (slice #41 of epic #35).
-- briefing_time is the local hour the briefing fires (HH:MM, but only the
-- hour is used for matching — minutes ignored). NULL = disabled.
-- last_briefing_sent_at is the idempotency stamp so the hourly cron doesn't
-- re-send within the same local day.
ALTER TABLE workspace_ai_config
  ADD COLUMN briefing_time time,
  ADD COLUMN last_briefing_sent_at timestamptz;

COMMENT ON COLUMN workspace_ai_config.briefing_time IS
  'Local hour the morning briefing fires (HH:00; minutes ignored). NULL disables. Default 07:00 for workspaces with whatsapp_outbound_enabled.';

COMMENT ON COLUMN workspace_ai_config.last_briefing_sent_at IS
  'Idempotency stamp — last successful briefing send. The cron skips if last send is within the same local day.';

-- Default 07:00 for existing workspaces that already have outbound enabled.
-- New workspaces can be enabled via SQL or future settings UI.
UPDATE workspace_ai_config
SET briefing_time = '07:00:00'
WHERE whatsapp_outbound_enabled = true
  AND briefing_time IS NULL;
