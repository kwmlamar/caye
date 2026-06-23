-- 2026-06-22 — receptionist-spec.md Block 1 + 3
--
-- Two independent column additions packaged together:
--
-- 1. Operator identity (Q11 lock) — minimal additions on `customers`.
--    Most of the spec'd fields (business_address, hours, services) already
--    live in `business_brief` jsonb or existing columns. Only the operator's
--    personal contact + free-form team notes need new columns.
--
-- 2. Shadow operator (Q4 lock) — two columns on `workspace_ai_config`:
--    a hard pause flag (default safe) and a notification destination
--    override. Lets us route Caye's WhatsApp pings to a test recipient
--    (Lamar) while keeping the canonical operator number untouched.

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS operator_personal_phone text,
  ADD COLUMN IF NOT EXISTS operator_personal_email text,
  ADD COLUMN IF NOT EXISTS team_notes text;

COMMENT ON COLUMN customers.operator_personal_phone IS
  'Operator''s personal phone (distinct from contact_phone which is the business line). Used by Caye when answering "what''s my number?" / when she needs to text the operator directly.';
COMMENT ON COLUMN customers.operator_personal_email IS
  'Operator''s personal email (distinct from contact_email which is the business address). Used by Caye when answering identity questions in back-office chat.';
COMMENT ON COLUMN customers.team_notes IS
  'Free text the operator wrote about their team and operating context. Loaded into the back-office system prompt verbatim so Caye knows things like "Max is my husband, helps on the boat" without a tool call.';

ALTER TABLE workspace_ai_config
  ADD COLUMN IF NOT EXISTS notifications_paused boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS operator_notification_override_phone text;

COMMENT ON COLUMN workspace_ai_config.notifications_paused IS
  'Hard kill on all outbound operator notifications (hold pings, urgent, EOD, morning, stale-hold). Default true for safety on new workspaces — explicit flip to false once the loop has been validated for that workspace.';
COMMENT ON COLUMN workspace_ai_config.operator_notification_override_phone IS
  'When set, all WhatsApp operator pings route here instead of operator_whatsapp_number. operator_whatsapp_number remains canonical for identity (back-office allowlist, voice profile linkage). Used during testing to receive pings on Lamar''s number while leaving Karenda''s number on the workspace.';
