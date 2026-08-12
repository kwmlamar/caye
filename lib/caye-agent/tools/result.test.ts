import { describe, it, expect, vi } from 'vitest'
import {
  classifyError,
  normalizeResult,
  stripForModel,
  deferred,
  succeeded,
  failedRetryable,
} from './result'

vi.mock('server-only', () => ({}))

describe('classifyError', () => {
  it('treats a unique violation as CONFLICT, not a retry', () => {
    // Retrying a duplicate-key failure produces the same failure forever, and
    // "already exists" is information the operator wants, not an error.
    const r = classifyError({ code: '23505', message: 'duplicate key' }, 'X')
    expect(r.status).toBe('CONFLICT')
    expect(r.retryable).toBe(false)
  })

  it('treats a bad enum literal as FAILED_PERMANENT', () => {
    // This is the exact shape of the add_internal_note failure: Postgres
    // 22P02 on sender_type. No amount of retrying fixes a wrong literal, and
    // classifying it retryable would have burned the whole attempt budget
    // before failing anyway.
    const r = classifyError(
      { code: '22P02', message: 'invalid input value for enum sender_type: "system"' },
      'ADD_INTERNAL_NOTE_FAILED'
    )
    expect(r.status).toBe('FAILED_PERMANENT')
    expect(r.retryable).toBe(false)
  })

  it('treats a connection-class SQLSTATE as retryable', () => {
    expect(classifyError({ code: '08006', message: 'connection failure' }, 'X').status).toBe(
      'FAILED_RETRYABLE'
    )
  })

  it('reads the HTTP status out of the Zoho helpers’ thrown messages', () => {
    // zoho-calendar.ts throws `Zoho Calendar create failed (503): ...`
    const down = classifyError(new Error('Zoho Calendar create failed (503): upstream'), 'Z')
    expect(down.status).toBe('FAILED_RETRYABLE')

    const gone = classifyError(new Error('Zoho Calendar update failed (404): no such event'), 'Z')
    expect(gone.status).toBe('NOT_FOUND')

    const unauth = classifyError(new Error('Zoho Calendar list failed (401): token'), 'Z')
    expect(unauth.status).toBe('NEEDS_HUMAN')

    const bad = classifyError(new Error('Zoho Calendar create failed (400): malformed'), 'Z')
    expect(bad.status).toBe('FAILED_PERMANENT')
  })

  it('classifies network errors as retryable', () => {
    for (const msg of ['fetch failed', 'ETIMEDOUT', 'socket hang up', 'ECONNRESET']) {
      expect(classifyError(new Error(msg), 'X').status).toBe('FAILED_RETRYABLE')
    }
  })

  it('defaults an unrecognised failure to retryable, not permanent', () => {
    // Deliberate asymmetry. A needless retry costs one round trip; a wrongly
    // permanent classification loses the operator's work.
    expect(classifyError(new Error('something odd'), 'X').status).toBe('FAILED_RETRYABLE')
  })

  it('never leaks an auth token or raw body into the operator-facing error', () => {
    const r = classifyError(new Error('Zoho Calendar list failed (401): Zoho-oauthtoken abc123'), 'Z')
    expect(r.error).not.toContain('abc123')
  })
})

describe('normalizeResult', () => {
  it('gives a legacy ok:true result a SUCCESS status', () => {
    expect(normalizeResult({ ok: true, data: { a: 1 } }, 'X').status).toBe('SUCCESS')
  })

  it('classifies an unstatused legacy failure as permanent rather than retrying it', () => {
    // ~60 tools still return the bare { ok:false, error } shape, almost all of
    // them ownership/validation rejections from _guards.ts. Retrying those is
    // the more dangerous default.
    const r = normalizeResult({ ok: false, error: 'Conversation not found in this workspace' }, 'T_FAILED')
    expect(r.status).toBe('FAILED_PERMANENT')
    expect(r.error_code).toBe('T_FAILED')
  })

  it('leaves an already-classified result alone', () => {
    const original = failedRetryable('ZOHO_DOWN', 'upstream')
    expect(normalizeResult(original, 'IGNORED')).toEqual(original)
  })
})

describe('stripForModel', () => {
  it('withholds internal codes from the model', () => {
    // Item 12: internal vocabulary must not reach a human, and the shortest
    // path from a tool_result to Mrs. Max's phone is the model repeating it.
    const payload = stripForModel(failedRetryable('ZOHO_NOTE_CREATE_FAILED', 'upstream timeout'))
    expect(JSON.stringify(payload)).not.toContain('ZOHO_NOTE_CREATE_FAILED')
    expect(payload.status).toBe('FAILED_RETRYABLE')
  })

  it('marks a deferred write as saved so the model reports it as done', () => {
    const payload = stripForModel(deferred({ id: 'b1' }, 'Saved — calendar will catch up.'))
    expect(payload.ok).toBe(true)
    expect(payload.saved_locally).toBe(true)
    expect(payload.tell_the_operator).toContain('Saved')
  })

  it('passes success data straight through', () => {
    expect(stripForModel(succeeded({ note_added: true })).data).toEqual({ note_added: true })
  })
})
