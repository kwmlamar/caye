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
    expect(classifyToolResponse('NEEDS_HUMAN', false, 'draft_in_inbox')?.intent).toBe('blocked')
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

  it('forbids claiming a platform escalation that never happened', () => {
    const { instruction } = classifyToolResponse('FAILED_PERMANENT', false)!
    expect(instruction).toMatch(/tropitech, engineering, or any other team/i)
  })

  it('gives the draft_in_inbox failure the exact preserved-draft shape the fixture expects', () => {
    const { instruction } = classifyToolResponse('FAILED_PERMANENT', false, 'draft_in_inbox')!
    expect(instruction).toMatch(/couldn't save it to the inbox/i)
    expect(instruction).toMatch(/kept the draft here/i)
    expect(instruction).toMatch(/do not offer to send it instead/i)
  })
})
