import { describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { classifyAIError } from './errors'
import { policyFor } from './errors'
import { modelCanServe } from './capabilities'
import { MODELS } from './models'
import type { AIMessageParams } from './types'

/**
 * Regression coverage for the 2026-09-01 production outage.
 *
 * Anthropic's balance was exhausted, so the gateway failed over to OpenAI as
 * designed. The founder's back-office tool surface is 129 tools; OpenAI caps
 * the tools array at 128 and answered HTTP 400 `array_above_max_length`.
 * That was classified `malformed_request` — a terminal, no-failover category
 * — so OpenRouter was never tried and the operator got
 * "Sorry, I hit a snag with that" three times in a row.
 *
 * The classification was the load-bearing bug: OpenRouter was verified
 * against the live API to accept the identical 129-tool request.
 */

/** Verbatim OpenAI 400 body from the production llm_call_log attempt trail. */
const OPENAI_TOOLS_OVER_CAP = {
  status: 400,
  message:
    "openai request failed (400): {\n  \"error\": {\n    \"message\": \"Invalid 'tools': array too long. " +
    'Expected an array with maximum length 128, but got an array with length 129 instead.",\n    ' +
    '"type": "invalid_request_error",\n    "param": "tools",\n    "code": "array_above_max_length"\n  }\n}',
}

const OPENAI_OUTPUT_LIMIT = {
  status: 400,
  message:
    'openai request failed (400): { "error": { "message": "Could not finish the message because ' +
    'max_tokens or model output limit was reached. Please try again with higher max_tokens.", ' +
    '"type": "invalid_request_error" } }',
}

function paramsWithTools(count: number): AIMessageParams {
  return {
    model: 'auto',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'Switch to ods' }],
    tools: Array.from({ length: count }, (_, i) => ({
      name: `tool_${i}`,
      description: `tool ${i}`,
      input_schema: { type: 'object' as const, properties: {}, required: [] },
    })),
  } as unknown as AIMessageParams
}

describe('provider tool-capacity limits are routed around, not treated as Caye bugs', () => {
  it("classifies OpenAI's over-cap tools array as a capability limit that fails over", () => {
    const classified = classifyAIError(OPENAI_TOOLS_OVER_CAP, 'openai', 'gpt-5')
    // Before the fix this was 'malformed_request' (failover: false), which
    // ended the route at OpenAI and never reached OpenRouter.
    expect(classified.category).toBe('unsupported_capability')
    expect(policyFor(classified.category).failover).toBe(true)
  })

  it('does not open a circuit for a tool-capacity rejection — the provider is healthy', () => {
    const classified = classifyAIError(OPENAI_TOOLS_OVER_CAP, 'openai', 'gpt-5')
    expect(policyFor(classified.category).opensCircuit).toBe(false)
  })

  it("treats OpenAI's output-limit 400 as failover-eligible too", () => {
    const classified = classifyAIError(OPENAI_OUTPUT_LIMIT, 'openai', 'gpt-5')
    expect(policyFor(classified.category).failover).toBe(true)
  })

  it('still treats a genuinely malformed request as terminal', () => {
    const classified = classifyAIError(
      { status: 400, message: 'openai request failed (400): unknown parameter "frobnicate"' },
      'openai',
      'gpt-5'
    )
    expect(classified.category).toBe('malformed_request')
    expect(policyFor(classified.category).failover).toBe(false)
  })

  it('still treats a real tool-schema defect as terminal rather than shopping providers', () => {
    const classified = classifyAIError(
      { status: 400, message: 'tools.0.custom.input_schema: invalid schema for tool' },
      'anthropic',
      'claude-sonnet-4-6'
    )
    expect(classified.category).toBe('invalid_tool_or_schema')
    expect(policyFor(classified.category).failover).toBe(false)
  })

  it('skips OpenAI up front for a 129-tool request instead of spending a 400', () => {
    const verdict = modelCanServe(MODELS.openai_strong, paramsWithTools(129))
    expect(verdict).toEqual({ ok: false, missing: 'tool_capacity' })
  })

  it('still routes a 128-tool request to OpenAI — the cap is inclusive', () => {
    expect(modelCanServe(MODELS.openai_strong, paramsWithTools(128))).toEqual({ ok: true })
  })

  it('does not cap OpenRouter, which was verified to serve the 129-tool request', () => {
    expect(modelCanServe(MODELS.openrouter_strong, paramsWithTools(129))).toEqual({ ok: true })
  })

  it('does not cap Anthropic, which served this surface in production for months', () => {
    expect(modelCanServe(MODELS.anthropic_strong, paramsWithTools(129))).toEqual({ ok: true })
  })

  it('leaves the agent_planning route with a provider that can serve 129 tools', () => {
    // The invariant the outage violated: a provider-independent operation
    // must still have somewhere to go when the preferred provider is out.
    const params = paramsWithTools(129)
    const eligible = (['anthropic_strong', 'openai_strong', 'openrouter_strong'] as const).filter(
      (key) => modelCanServe(MODELS[key], params).ok
    )
    expect(eligible.length).toBeGreaterThan(0)
    // Specifically: with Anthropic down, something non-Anthropic remains.
    const withoutAnthropic = eligible.filter((key) => MODELS[key].provider !== 'anthropic')
    expect(withoutAnthropic.length).toBeGreaterThan(0)
  })
})
