-- Foundation for back-office Caye (epic #35, slice #36).
-- Adds Claude's rich message format alongside the legacy {direction, body}
-- columns so the new tool-use agent can reconstruct the conversation for
-- Claude's API in subsequent turns. Future tool_use / tool_result blocks
-- live in this column. Legacy rows stay null and are reconstructed from
-- direction + body by the sliding-window loader.
ALTER TABLE caye_operator_messages
  ADD COLUMN claude_format jsonb;

COMMENT ON COLUMN caye_operator_messages.claude_format IS
  'Anthropic MessageParam shape for this turn (role + content blocks). Null on legacy rows pre-back-office-agent; the context loader falls back to direction+body for those.';
