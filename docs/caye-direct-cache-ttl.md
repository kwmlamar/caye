# Caye Direct cache TTL

CAY-23 keeps Caye Direct's stable Anthropic tool-schema cache at a 1-hour TTL while using a 5-minute TTL for the request-varying system prompt.

The system prompt includes current founder thread and workspace operating context, so it may legitimately change between human turns. A 5-minute cache still spans the rapid multi-turn tool loop for one interaction without paying the longer-TTL write premium for context that often will not be reused an hour later.

This is a request-shaping optimization only. It does not change prompt text, model selection, routing, tools, authority, confirmation, execution, or persistence semantics.

After rollout, compare `lib/model-router/backends/anthropic-api.ts:invokeTurn` cache creation/read telemetry against the pre-rollout baseline before applying the same pattern to shared `runToolLoop`.