-- Durable provenance for multi-step investigations (2026-08-17 Bimini
-- revenue-audit incident).
--
-- caye_tool_calls already recorded THAT a tool ran and whether it
-- succeeded, but not what it returned or what it was about — and had no
-- way to group calls made across more than one runToolLoop invocation
-- (one per inbound message / API call). A founder-authorized investigation
-- that spans several internal continuations (see lib/caye-agent/
-- investigation.ts) needs both: a stable id linking every call in the
-- investigation together, and enough of each call's own identity (its
-- arguments, and the tool_use_id joining it back to the exact tool_result
-- persisted in caye_operator_messages.claude_format) to answer "what do we
-- believe, and which record does it come from" without replaying the raw
-- conversation — which lib/caye-agent/history-compaction.ts may have
-- already elided by the time anyone asks.
--
-- Additive only. All three columns are nullable; every existing row and
-- every caller that doesn't know about investigations keeps working
-- unchanged.

alter table caye_tool_calls
  add column if not exists investigation_id text,
  add column if not exists tool_use_id text,
  add column if not exists args jsonb;

comment on column caye_tool_calls.investigation_id is
  'Groups tool calls made across one logical multi-turn investigation (lib/caye-agent/investigation.ts). Null for ordinary single-turn tool calls.';
comment on column caye_tool_calls.tool_use_id is
  'The Anthropic tool_use block id. Joins back to the exact tool_result block persisted in caye_operator_messages.claude_format, which is never compacted at rest — only elided from future replay context. This is how a finding keeps provenance to its raw record after compaction.';
comment on column caye_tool_calls.args is
  'Tool call arguments (e.g. conversation_id, date range) — identifies which record a finding is about without re-reading the transcript.';

-- "Resume this investigation" / "what has it found so far" — the query a
-- continuation turn (and a human debugging one) actually runs.
create index if not exists caye_tool_calls_investigation_idx
  on caye_tool_calls (investigation_id, created_at)
  where investigation_id is not null;
