import { describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))
import { backendSupports, requiredCapabilitiesFor } from './capabilities'

describe('backendSupports', () => {
  it('subscription backends do not claim tool_use (text-in/text-out only in this phase)', () => {
    expect(backendSupports('claude_subscription', 'tool_use')).toBe(false)
    expect(backendSupports('openai_codex_subscription', 'tool_use')).toBe(false)
  })

  it('API backends do claim tool_use', () => {
    expect(backendSupports('anthropic_api', 'tool_use')).toBe(true)
    expect(backendSupports('openai_api', 'tool_use')).toBe(true)
  })

  it('only anthropic_api claims persisted_session', () => {
    expect(backendSupports('anthropic_api', 'persisted_session')).toBe(true)
    expect(backendSupports('claude_subscription', 'persisted_session')).toBe(false)
    expect(backendSupports('openai_codex_subscription', 'persisted_session')).toBe(false)
    expect(backendSupports('openai_api', 'persisted_session')).toBe(false)
  })
})

describe('requiredCapabilitiesFor', () => {
  it('always requires general_reasoning at minimum', () => {
    expect(requiredCapabilitiesFor(undefined)).toEqual(['general_reasoning'])
  })

  it('maps hints to their corresponding capabilities', () => {
    const required = requiredCapabilitiesFor({
      isCodingOrRepoTask: true,
      needsLongContext: true,
      needsVision: true,
      needsToolUse: true,
      needsSessionContinuity: true,
    })
    expect(required).toEqual(['general_reasoning', 'coding', 'long_context', 'vision', 'tool_use', 'persisted_session'])
  })
})
