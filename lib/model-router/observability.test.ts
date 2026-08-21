import { describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))
import { redactSecrets, buildInvocationLog } from './observability'

describe('redactSecrets', () => {
  it('redacts an Anthropic API key', () => {
    const out = redactSecrets('failed with key sk-ant-api03-abc123DEF456_-xyz')
    expect(out).not.toContain('sk-ant-api03')
    expect(out).toContain('[redacted]')
  })

  it('redacts an Anthropic OAuth token (subscription-derived)', () => {
    const out = redactSecrets('token sk-ant-oat01-verylongtokenvalue1234567890')
    expect(out).not.toContain('sk-ant-oat01')
  })

  it('redacts an OpenAI-style API key', () => {
    const out = redactSecrets('using sk-proj-abcdefghijklmnopqrstuvwxyz1234567890')
    expect(out).not.toMatch(/sk-proj-[a-zA-Z0-9]{20,}/)
  })

  it('redacts a bearer token', () => {
    const out = redactSecrets('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def')
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiJ9')
    expect(out).toContain('[redacted]')
  })

  it('redacts an access_token field', () => {
    const out = redactSecrets('{"access_token": "abcdefghijklmnopqrstuvwxyz123456"}')
    expect(out).not.toContain('abcdefghijklmnopqrstuvwxyz123456')
  })

  it('leaves ordinary error text untouched', () => {
    const msg = 'claude CLI exited 1: rate limit exceeded, try again later'
    expect(redactSecrets(msg)).toBe(msg)
  })
})

describe('buildInvocationLog', () => {
  it('redacts secrets that leak into a failure summary before they reach the log shape', () => {
    const log = buildInvocationLog({
      requestedMode: 'claude',
      fallbackSequence: [],
      latencyMs: 500,
      success: false,
      failureSummary: 'auth error using sk-ant-api03-leakedkeyvalue123456',
      threadId: 'thread-1',
      founderUserId: 'lamar',
    })
    expect(log.failureSummary).not.toContain('sk-ant-api03')
    expect(log.loggedAt).toBeTruthy()
  })

  it('never includes a raw error object, only a redacted string summary', () => {
    const log = buildInvocationLog({
      requestedMode: 'auto',
      selectedBackend: 'anthropic_api',
      fallbackSequence: [{ backend: 'claude_subscription', reason: 'quota_exhausted' }],
      latencyMs: 800,
      success: true,
      inputTokens: 120,
      outputTokens: 40,
      threadId: 'thread-1',
      founderUserId: 'lamar',
    })
    expect(typeof log).toBe('object')
    expect(Object.values(log).every((v) => typeof v !== 'function')).toBe(true)
    expect(log.selectedBackend).toBe('anthropic_api')
    expect(log.fallbackSequence).toHaveLength(1)
  })
})
