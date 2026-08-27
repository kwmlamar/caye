# runToolLoop cost audit

This audit uses the approximately 30-day `llm_call_log` totals supplied for `lib/caye-agent/execute.ts:runToolLoop`: 1,259 Sonnet calls, 6,434,864 input tokens, 199,507 output tokens, 22,739,965 cache-read tokens, and 3,817,785 cache-creation tokens.

## Anatomy

`cayeAgent()` builds a workspace/caller-aware back-office system prompt, then `runToolLoop()` repeatedly sends that prompt, message history, and tools until Claude returns text or the five-iteration limit is reached. Tool results become the next user turn. Tool execution remains behind role checks, recovery, high-risk confirmation gates, idempotency, evidence/disposition checks, and action-claim grounding.

The current telemetry is one row per model turn, not one row per top-level loop invocation. It therefore proves 1,259 model turns but cannot calculate average, p95, or maximum turns per invocation retrospectively.

## Context and cache findings

- System prompt: includes reliability-critical caller identity, business identity, workspace-local date grounding, voice profile, thread context, scan attention state, and active work. These are not removed by this change.
- History: ordinary turns replay a bounded operator/thread history; investigation continuations already replace it with a deterministic tool-call digest.
- Tools: system and tool definitions use Anthropic one-hour ephemeral cache controls. The observed cache reads show the prefix cache is active; cache creation still occurs when a workspace/caller prompt or cache lifetime changes.
- Dynamic prompt data prevents treating the complete system prompt as globally static without a larger prompt-composition redesign. That is deferred because it risks moving or weakening date, identity, active-work, and operational-state guidance.

## Selected optimization: deterministic role-based tool surface

Before this change, the default loop sent every schema matching its mode, then rejected a role-ineligible tool only after Claude chose it. The loop now omits schemas that the caller's role cannot execute. Execution-time role checks remain intact, and caller-provided replay/custom registries remain unchanged.

Current back-office measurements from the registry:

| Caller role | Exposed tools | Role-excluded tools | Excluded schema bytes |
| --- | ---: | ---: | ---: |
| owner | 73 | 4 | 3,586 |
| founder | 77 | 0 | 0 |
| staff | 13 | 64 | 73,576 |

This saves 3,586 serialized schema bytes per owner model request and 73,576 per staff model request before provider tokenization. The supplied telemetry has no role breakdown, so aggregate token savings cannot be estimated honestly yet. Metadata-only tool-surface logs now record exposed/excluded counts and bytes by loop invocation for that measurement.

## Rejected opportunities

- Routine-model tool selection/ranking: may suppress a necessary tool, so Sonnet remains the planner.
- Replacing the loop's final text turn: the final answer may describe consequential state and requires the same action/evidence grounding.
- Removing business facts, thread history, active work, date, or owner operational state: these are reliability inputs, not expendable context.
- Fuzzy iteration tiering: no hard state boundary proves a turn is low consequence.
- Broader context-prefix cache refactor: potentially high value, but needs separate equivalence review of prompt ordering and cache checkpoints.

## Rollout

No configuration is required. The change is deterministic and easily rolled back. Monitor `[caye-agent/execute] tool surface` logs alongside existing `llm_call_log` rows to establish role mix, exposed tool count, schema bytes, token use, and cache behavior before considering deeper cache/prompt work.
