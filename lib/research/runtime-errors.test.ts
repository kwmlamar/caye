import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase-server', () => ({ createServiceClient: () => ({}) }))

import { describeResearchError } from './runtime'

describe('describeResearchError', () => {
  it('keeps a normal Error message', () => {
    expect(describeResearchError(new Error('boom'))).toBe('boom')
  })

  // Several production runs recorded the literal "[object Object]" because a
  // Postgrest rejection is a plain object, leaving nothing to diagnose.
  it('preserves Postgrest rejection detail instead of "[object Object]"', () => {
    const postgrest = { code: '22P05', message: 'unsupported Unicode escape sequence', details: 'null bytes', hint: null }
    const described = describeResearchError(postgrest)
    expect(described).toContain('22P05')
    expect(described).toContain('unsupported Unicode escape sequence')
    expect(described).not.toBe('[object Object]')
  })

  it('falls back to JSON for an object with no recognized fields', () => {
    expect(describeResearchError({ weird: true })).toBe('{"weird":true}')
  })

  it('stringifies primitives', () => {
    expect(describeResearchError('plain')).toBe('plain')
    expect(describeResearchError(null)).toBe('null')
  })
})
