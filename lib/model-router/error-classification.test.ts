import { describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))
import { classifyBackendError } from './error-classification'

describe('classifyBackendError', () => {
  it('classifies a missing CLI binary as fallback: client_unavailable', () => {
    const result = classifyBackendError({ message: 'spawn claude ENOENT', clientMissing: true })
    expect(result).toEqual({ fallback: true, reason: 'client_unavailable' })
  })

  it('classifies an expired/unrenewable auth session as fallback: auth_required', () => {
    const result = classifyBackendError({ message: 'Login expired', authExpired: true })
    expect(result).toEqual({ fallback: true, reason: 'auth_required' })
  })

  it('classifies HTTP 401 as fallback: auth_required', () => {
    const result = classifyBackendError({ message: 'unauthorized', httpStatus: 401 })
    expect(result).toEqual({ fallback: true, reason: 'auth_required' })
  })

  it('classifies HTTP 403 as fallback: auth_required', () => {
    const result = classifyBackendError({ message: 'forbidden', httpStatus: 403 })
    expect(result).toEqual({ fallback: true, reason: 'auth_required' })
  })

  it('classifies HTTP 429 as fallback: rate_limited', () => {
    const result = classifyBackendError({ message: 'too many requests', httpStatus: 429 })
    expect(result).toEqual({ fallback: true, reason: 'rate_limited' })
  })

  it('classifies a quota-shaped 400 as fallback: quota_exhausted', () => {
    const result = classifyBackendError({ message: 'You have exceeded your usage limit for this plan', httpStatus: 400 })
    expect(result).toEqual({ fallback: true, reason: 'quota_exhausted' })
  })

  it('classifies a plain 400 (malformed request) as NOT fallback — this is a request-shape bug, not a provider problem', () => {
    const result = classifyBackendError({ message: 'invalid request: missing field "messages"', httpStatus: 400 })
    expect(result).toEqual({ fallback: false, reason: 'malformed_request' })
  })

  it('classifies HTTP 500 as fallback: transient_provider_failure', () => {
    const result = classifyBackendError({ message: 'internal server error', httpStatus: 500 })
    expect(result).toEqual({ fallback: true, reason: 'transient_provider_failure' })
  })

  it('classifies a nonzero CLI exit code with no other signal as fallback: transient_provider_failure', () => {
    const result = classifyBackendError({ message: 'claude CLI exited 1', exitCode: 1 })
    expect(result).toEqual({ fallback: true, reason: 'transient_provider_failure' })
  })

  it('classifies a totally unknown error as fallback: transient_provider_failure (fail open toward retry, not toward silence)', () => {
    const result = classifyBackendError({ message: 'ECONNRESET' })
    expect(result).toEqual({ fallback: true, reason: 'transient_provider_failure' })
  })
})
