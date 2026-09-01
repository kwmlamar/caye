# Caye AI Gateway

**Status:** live. All 34 AI call sites route through it.
**Code:** `lib/ai/` · **Compat facade:** `lib/llm-telemetry.ts` · **Admin:** Settings → Operations → AI providers

## Why this exists

Caye was coupled to one AI vendor. Every feature imported the Anthropic SDK,
constructed a client, and called `messages.create` with a hardcoded model id.
When the Anthropic account ran out of credit (observed 2026-08-31: 14 failed
production research runs, HTTP **400** with `"Your credit balance is too low"`),
customer-facing and autonomous workflows failed outright. There was no route
around it.

Claude is now one replaceable supplier. Feature code asks for a **capability**;
the gateway decides **who answers**.

## Before / after

```
BEFORE                          AFTER

feature                         feature
  ↓                               ↓
new Anthropic()                 lib/ai gateway
  ↓                               ↓
messages.create(model)          task route + capability check + circuit breaker
  ↓                               ↓        ↓ unavailable
Claude                          Anthropic  →  OpenAI  →  OpenRouter
  ↓                                              ↓
failure if Anthropic is down    normalized Caye response + routing metadata
```

## Call contract

```ts
const result = await ai.generate({
  params: { model, max_tokens, system, messages, tools },
  ctx: { source: 'lib/caye-reply.ts:replyLoop', task: 'customer_response', workspaceId },
})

result.output   // normalized message, Caye canonical block shape
result.usage    // tokens + computed cost
result.routing  // { provider, model, attempts[], fellBack, latencyMs }
```

Anthropic-shaped call sites use `loggedMessagesCreate(null, params, ctx)` from
`lib/llm-telemetry.ts`, which is a thin facade over the same gateway. The first
argument is vestigial — see that file's doc comment for why it was kept.

`params.model` is **advisory**. The gateway overrides it with the model from the
task route. A call site cannot pin Caye to a vendor (except via
`ctx.pinProvider`, which exists only for the founder's explicit model picker and
the admin "test provider" action).

## Why the canonical shape is Anthropic-schema'd

Caye's canonical wire format is `{ role, content: [{type:'text'|'tool_use'|
'tool_result'|'image'}] }` — the Anthropic Messages schema. That is what ~40
call sites, the agent tool loop, the persisted `caye_operator_messages.
claude_format` column, the replay harness, and every guard in `lib/caye-agent`
already speak. Re-encoding all of it into a new neutral shape during a
provider-independence migration would have changed Caye's behaviour, which this
work was explicitly not allowed to do.

So `lib/ai/types.ts` sources those types from `@anthropic-ai/sdk` as a
**type-only** import: compile-time only, zero runtime footprint, no client, no
key read, no network path. Runtime provider SDK usage is confined to
`lib/ai/providers/anthropic.ts`. OpenAI and OpenRouter translate in
`lib/ai/providers/openai-translate.ts`.

This is enforced, not just documented: `lib/ai/no-direct-provider-calls.test.ts`
fails CI on a runtime SDK import, a `new Anthropic()`, a `messages.create`, or a
raw `ANTHROPIC_API_KEY` read outside an adapter.

## Routing

`lib/ai/routes.ts` maps each task to an ordered list of models from the
`lib/ai/models.ts` catalogue. Every task can reach all three providers — a
test enforces that, so a new task cannot re-create single-vendor coupling.

| Task | 1st | 2nd | 3rd |
|---|---|---|---|
| `customer_response`, `operator_response`, `agent_planning`, `business_analysis`, `opportunity_detection`, `onboarding`, `outreach`, `other` | Anthropic strong | OpenAI strong | OpenRouter strong |
| `classification`, `fact_extraction`, `summarization` | Anthropic cheap | OpenAI cheap | Anthropic strong → OpenRouter cheap |
| `research` | OpenAI strong | Anthropic strong | OpenRouter strong |

Customer-visible generation and real reasoning lead with the strong tier: a
cheaper answer that reads wrong to a paying customer's guest costs more than the
token delta. High-volume, structurally-constrained work leads cheap. `research`
leads with OpenAI because `lib/research/providers/config.ts` had already made
that call for cost reasons, and this migration must not silently re-price
research.

A route is **skipped** (not failed) when the provider is disabled, has no
credentials, is circuit-open, or the model cannot serve a required capability
(tool use, vision, or context window — all read off the request itself, not
declared by the caller).

## Failure classification

`lib/ai/errors.ts` is one table, not scattered judgement.

**Fails over** — the provider can't serve anyone right now:
`billing_exhausted`, `authentication`, `quota`, `rate_limit`, `timeout`,
`network`, `upstream_5xx`.

**Does not fail over** — the request itself is broken, or a send may already
have happened: `malformed_request`, `invalid_tool_or_schema`, `content_policy`,
`side_effect_may_have_occurred`. Fanning a broken request across three providers
buys three identical errors, three bills, and a slower failure.

**Fails over but never opens a circuit** — provider is healthy, this request
just doesn't fit it: `context_length_exceeded`, `unsupported_capability`.

The billing test runs **before** the generic 4xx branch, because Anthropic
returns 400 for an exhausted balance. Classifying that as `malformed_request`
would mark a billing outage as a Caye bug and block failover — the exact
production failure this gateway exists to survive.

Only `rate_limit` retries in place (once, capped at 2s). Everything else fails
over immediately: retrying a 500 or a timeout in place just adds latency.

## Circuit breaker

State lives in `ai_provider_health` (one row per provider, three rows total)
with a 5s in-process cache in front, so the common path is not a database round
trip and a provider found dead on instance A is not re-probed by instance B.

| Failure | Threshold | Cooldown |
|---|---|---|
| `billing_exhausted`, `authentication` | 1 | 30 min |
| `quota` | 1 | 10 min |
| `rate_limit` | 3 | 1 min |
| `timeout`, `network` | 3 | 1 min |
| `upstream_5xx` | 3 | 2 min |

A billing/auth cooldown is released early when the **credential fingerprint**
changes — topping up an account or rotating a key brings the provider back
immediately, rather than serving a 30-minute punishment. The fingerprint is a
non-reversible hash; the key never leaves the adapter.

Deliberately not a distributed system. Three providers do not justify leases or
quorums; concurrent writers race on one row, last write wins, and the worst case
is a slightly wrong timestamp that self-corrects on the next call.

**Fails open.** If the health store is unreachable, every provider is treated as
eligible. A telemetry outage must never take Caye's AI offline.

## Streaming

Caye has **no streaming model calls**. There is therefore no mid-stream
fallback problem to solve, and none is implemented. That is enforced, not
assumed: `no-direct-provider-calls.test.ts` fails on `stream: true` or
`.messages.stream(`, so the day someone adds streaming, the partial-output
failover rules have to be designed before it ships.

## Configuration

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `OPENROUTER_API_KEY` | Provider credentials. Any one is enough to run. |
| `ANTHROPIC_STRONG_MODEL`, `ANTHROPIC_CHEAP_MODEL`, `OPENAI_STRONG_MODEL`, `OPENAI_API_MODEL`, `OPENROUTER_STRONG_MODEL`, `OPENROUTER_MODEL` | Override catalogue model ids. |
| `CAYE_AI_ROUTE_<TASK>` | Per-task route override, e.g. `CAYE_AI_ROUTE_CLASSIFICATION=openai_cheap,openrouter_cheap`. |
| `CAYE_AI_PROVIDER_ORDER` | Global reorder for an incident, e.g. `openai,anthropic,openrouter`. Reorders; never adds a route a task didn't have. |
| `CAYE_AI_REQUEST_TIMEOUT_MS` | Per-request timeout (default 120s). |

Missing credentials for one provider never block startup.
`validateAiConfiguration()` reports validity and is surfaced on the founder
Health rail; it deliberately does **not** throw at module load, because on
Vercel a module-scope throw takes down every route in the bundle — including the
health endpoint that is the only way to diagnose the missing key.

## Observability

Every attempt writes to `llm_call_log` (extended, not replaced, so the existing
spend surfaces keep working): `provider`, `task`, `outcome`, `failure_category`,
`fallback_used`, `latency_ms`, and the full `attempts` JSON trail including
providers that were skipped and why.

Answers: which provider is Caye using; how often is failover happening; why did
a provider get skipped; what did each workspace cost; which tasks cost the most;
which providers fail most.

**Boundary:** this is infrastructure telemetry. It is never read back as
business memory, never fed to business learning, and never influences what Caye
believes about a customer.

## Safety boundary

Provider routing does **not** touch workspace isolation, booking rules,
business-memory rules, approval gates, high-risk action gates, tool
authorization, owner/operator precedence, proactive-action policy, learning
eligibility, or customer-communication policy. Those are decided before a
request reaches the gateway and enforced after it returns, by the same
deterministic code regardless of who served the turn. A provider swap changes
latency and cost. It must never change what Caye is allowed to do.

`gateway.test.ts` asserts that the request passes through unmodified — routing
never edits prompts — and that a possible side effect suppresses failover.

## Remaining direct provider dependencies

`lib/research/anthropic.ts` and `lib/research/providers/anthropic.ts` still call
the Anthropic SDK for `search` and `fetch`. Those use Anthropic's **server-side
web search and web fetch tools**, which have no equivalent in the gateway's
chat-completion contract. They are adapters, not coupling: `lib/research/
providers/router.ts` already falls over to the OpenAI and OpenRouter research
adapters. The plain text-in/text-out `complete` path on the same adapter *does*
go through the gateway (pinned to Anthropic), so it gets the shared circuit
breaker — which is what stops an exhausted balance from costing a failed round
trip on every research cycle.
