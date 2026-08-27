import { describe, it, expect } from 'vitest'
import { classifyToolResponse } from './response-intent'

describe('classifyToolResponse — intent tagging', () => {
  it('tags a deferred write as completed', () => {
    expect(classifyToolResponse('SUCCESS', true)?.intent).toBe('completed')
  })

  it('tags a plain success as no-op (no instruction needed)', () => {
    expect(classifyToolResponse('SUCCESS', false)).toBeNull()
    expect(classifyToolResponse(undefined, false)).toBeNull()
  })

  it('tags a generic failure as failed', () => {
    expect(classifyToolResponse('FAILED_PERMANENT', false)?.intent).toBe('failed')
    expect(classifyToolResponse('FAILED_RETRYABLE', false)?.intent).toBe('failed')
  })

  it('tags a not-found lookup as needs_clarification', () => {
    expect(classifyToolResponse('NOT_FOUND', false)?.intent).toBe('needs_clarification')
  })

  it('tags a conflict as a warning', () => {
    expect(classifyToolResponse('CONFLICT', false)?.intent).toBe('warning')
  })

  it('tags NEEDS_HUMAN as blocked', () => {
    expect(classifyToolResponse('NEEDS_HUMAN', false)?.intent).toBe('blocked')
  })
})

describe('classifyToolResponse — failure instruction discipline (CAY-140)', () => {
  it('explicitly bans the "you are on it" promise rather than issuing it', () => {
    for (const status of ['FAILED_PERMANENT', 'FAILED_RETRYABLE'] as const) {
      const { instruction } = classifyToolResponse(status, false)!
      expect(instruction).toMatch(/do not say you are on it/i)
      expect(instruction).toMatch(/exhausted every retry/i)
    }
  })

  it('forbids inventing an infrastructure cause', () => {
    const { instruction } = classifyToolResponse('FAILED_PERMANENT', false)!
    expect(instruction).toMatch(/do not guess or invent a reason/i)
  })

  it('forbids inventing a platform-side escalation while not banning real operator messaging', () => {
    const { instruction } = classifyToolResponse('FAILED_PERMANENT', false)!
    expect(instruction).toMatch(/tropitech, engineering, developers, or support/i)
    expect(instruction).not.toMatch(/any other team/i)
  })

  it('does not own draft_in_inbox evidence semantics after #142', () => {
    const generic = classifyToolResponse('FAILED_PERMANENT', false, 'draft_in_inbox')!
    expect(generic.intent).toBe('failed')
    expect(generic.instruction).not.toMatch(/kept the draft here/i)
    expect(generic.instruction).not.toMatch(/blocked or uncertain/i)
  })
})
