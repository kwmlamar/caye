import { describe, expect, it } from 'vitest'
import { decideSalesOutreachWorkflow } from './outreach-workflow'

const base = {
  stage: 'contacted' as const, firstTouchSentAt: '2026-08-01T00:00:00Z', touchesSent: 1,
  lastTouchSentAt: null, optedOutAt: null, inboundKind: null, outreachDeferredAt: null,
  disqualifyingSignal: null,
}

describe('Sales outbound workflow', () => {
  it('uses canonical Sales facts for a due follow-up', () => {
    expect(decideSalesOutreachWorkflow(base, new Date('2026-08-05T00:00:00Z'))).toEqual({ kind: 'send_followup', touchNumber: 2 })
  })
  it('defers an automated inbound response', () => {
    expect(decideSalesOutreachWorkflow({ ...base, inboundKind: 'automated_ooo', outreachDeferredAt: '2026-08-02T00:00:00Z' }, new Date('2026-08-05T00:00:00Z')).kind).toBe('do_nothing')
  })
})
