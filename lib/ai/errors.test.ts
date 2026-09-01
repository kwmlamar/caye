import { describe, it, expect, vi } from 'vitest'
vi.mock('server-only', () => ({}))

const { classifyAIError, policyFor } = await import('./errors')
const { AIProviderError } = await import('./types')

const err = (status: number | undefined, message: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(message), status === undefined ? extra : { status, ...extra })

describe('error classification', () => {
  it('classifies an exhausted Anthropic balance as billing, not a bad request', () => {
    // The real production shape: HTTP 400, not 402. Getting this wrong marks
    // a billing outage as Caye's bug and blocks failover entirely.
    const classified = classifyAIError(
      err(400, 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing.')
    )
    expect(classified.category).toBe('billing_exhausted')
    expect(policyFor(classified.category).failover).toBe(true)
  })

  it('classifies OpenAI quota exhaustion as billing', () => {
    expect(classifyAIError(err(429, 'You exceeded your current quota, please check your plan and billing details.')).category)
      .toBe('billing_exhausted')
  })

  it('classifies 402 as billing', () => {
    expect(classifyAIError(err(402, 'Payment required')).category).toBe('billing_exhausted')
  })

  it('classifies 401/403 as authentication', () => {
    expect(classifyAIError(err(401, 'invalid api key')).category).toBe('authentication')
    expect(classifyAIError(err(403, 'forbidden')).category).toBe('authentication')
  })

  it('classifies plain 429 as a rate limit and carries retry-after', () => {
    const classified = classifyAIError(err(429, 'Rate limit reached', { headers: { 'retry-after': '3' } }))
    expect(classified.category).toBe('rate_limit')
    expect(classified.opts.retryAfterMs).toBe(3000)
  })

  it('classifies aborts and timeouts', () => {
    expect(classifyAIError(Object.assign(new Error('x'), { name: 'AbortError' })).category).toBe('timeout')
    expect(classifyAIError(err(504, 'gateway timeout')).category).toBe('timeout')
    expect(classifyAIError(err(undefined, 'The operation timed out')).category).toBe('timeout')
  })

  it('classifies 5xx as an upstream failure', () => {
    expect(classifyAIError(err(500, 'internal error')).category).toBe('upstream_5xx')
    expect(classifyAIError(err(529, 'overloaded')).category).toBe('upstream_5xx')
  })

  it('classifies transport failures as network', () => {
    expect(classifyAIError(new Error('fetch failed')).category).toBe('network')
    expect(classifyAIError(new Error('socket hang up')).category).toBe('network')
  })

  it('classifies context overflow separately from a malformed request', () => {
    const classified = classifyAIError(err(400, 'prompt is too long: 250000 tokens > 200000 maximum'))
    expect(classified.category).toBe('context_length_exceeded')
    // A different provider with a bigger window genuinely might succeed...
    expect(policyFor(classified.category).failover).toBe(true)
    // ...but the provider is healthy, so this must not open its circuit.
    expect(policyFor(classified.category).opensCircuit).toBe(false)
  })

  it('classifies a bad tool schema as a Caye bug that must not fan out', () => {
    const classified = classifyAIError(err(400, 'tools.0.input_schema: invalid schema for function'))
    expect(classified.category).toBe('invalid_tool_or_schema')
    expect(policyFor(classified.category).failover).toBe(false)
  })

  it('classifies a plain 400 as malformed and refuses failover', () => {
    const classified = classifyAIError(err(400, 'messages.1: unexpected role'))
    expect(classified.category).toBe('malformed_request')
    expect(policyFor(classified.category).failover).toBe(false)
  })

  it('reads a message out of a nested provider error envelope', () => {
    const nested = { status: 400, error: { type: 'invalid_request_error', message: 'credit balance is too low' } }
    expect(classifyAIError(nested).category).toBe('billing_exhausted')
  })

  it('passes an already-classified error through unchanged', () => {
    const original = new AIProviderError('side_effect_may_have_occurred', 'tool ran')
    expect(classifyAIError(original)).toBe(original)
  })
})

describe('failover policy', () => {
  it('fails over for every availability-shaped category', () => {
    for (const category of ['billing_exhausted', 'authentication', 'quota', 'rate_limit', 'timeout', 'network', 'upstream_5xx'] as const) {
      expect(policyFor(category).failover, category).toBe(true)
    }
  })

  it('never fails over for a deterministic programming error or a possible side effect', () => {
    for (const category of ['malformed_request', 'invalid_tool_or_schema', 'content_policy', 'side_effect_may_have_occurred'] as const) {
      expect(policyFor(category).failover, category).toBe(false)
    }
  })

  it('retries in place only for rate limiting', () => {
    const retried = (['billing_exhausted', 'authentication', 'quota', 'rate_limit', 'timeout', 'network', 'upstream_5xx', 'unknown'] as const)
      .filter((c) => policyFor(c).retrySameProvider)
    expect(retried).toEqual(['rate_limit'])
  })
})
