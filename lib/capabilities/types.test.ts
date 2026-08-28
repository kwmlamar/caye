import { describe, expect, expectTypeOf, it } from 'vitest'
import { capabilityWasExecuted, type CapabilityResult } from './types'

describe('capability result trust states', () => {
  it('narrows executed results to a required execution reference', () => {
    const result: CapabilityResult<{ id: string }> = {
      status: 'executed',
      data: { id: 'artifact-1' },
      evidence: [],
      executionRef: 'execution-1',
      auditRef: 'audit-1',
      failure: null,
    }

    if (capabilityWasExecuted(result)) {
      expectTypeOf(result.executionRef).toEqualTypeOf<string>()
      expect(result.executionRef).toBe('execution-1')
    }
  })

  it('keeps observations explicitly non-executed', () => {
    const result: CapabilityResult = {
      status: 'observed',
      data: { value: 1 },
      evidence: [{ kind: 'record', id: 'record-1' }],
      executionRef: null,
      auditRef: null,
      failure: null,
    }

    expect(capabilityWasExecuted(result)).toBe(false)
  })

  it('requires structured failure evidence for failed results', () => {
    const result: CapabilityResult = {
      status: 'failed',
      data: null,
      evidence: [],
      executionRef: null,
      auditRef: 'audit-failure-1',
      failure: {
        code: 'not_authorized',
        message: 'Founder scope required',
        retryable: false,
      },
    }

    expect(result.failure?.code).toBe('not_authorized')
  })
})
