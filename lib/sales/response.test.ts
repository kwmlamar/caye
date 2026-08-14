import { describe, expect, it } from 'vitest'
import { buildSalesResponseSystem, salesTools } from './response'
import type { SalesLeadContext } from './context'

const context: SalesLeadContext = {
  id: 'lead-1',
  stage: 'contacted',
  businessName: 'Harbor Cafe',
  touchCount: 1,
  inboundKind: 'human_reply',
  nextAction: { kind: 'do_nothing', reason: 'awaiting_human_reply' },
  signals: [],
  promptMemory: 'Where this prospect stands: contacted (Harbor Cafe).',
}

describe('Sales response boundary', () => {
  it('exposes only Sales-safe shared tools', () => {
    expect(salesTools([
      { name: 'send_reply' }, { name: 'check_availability' },
      { name: 'hold_for_human' }, { name: 'escalate_to_team' },
    ])).toEqual([
      { name: 'send_reply' }, { name: 'hold_for_human' }, { name: 'escalate_to_team' },
    ])
  })

  it('renders the canonical Sales lead context into the response instructions', () => {
    const system = buildSalesResponseSystem('base', undefined, '2026-08-14', context)
    expect(system.stable).toContain(context.promptMemory)
    expect(system.stable).toContain('sales inbox, not a customer-facing business inbox')
    expect(system.dynamic).toContain("Today's date: 2026-08-14")
  })
})
