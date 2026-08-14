import { describe, expect, it } from 'vitest'
import { buildSalesResponseSystem, salesTools } from './response'
import { classifySalesReplyIntent } from './reply-intent'
import type { SalesLeadContext } from './context'
import { CAYE_STANDARD_MONTHLY_PRICE_USD } from './facts'

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

  it('removes handoff tools for a known autonomous Sales intent', () => {
    expect(salesTools([
      { name: 'send_reply' }, { name: 'hold_for_human' }, { name: 'escalate_to_team' },
    ], true)).toEqual([{ name: 'send_reply' }])
  })

  it('renders the canonical Sales lead context into the response instructions', () => {
    const system = buildSalesResponseSystem('base', undefined, '2026-08-14', context)
    expect(system.stable).toContain(context.promptMemory)
    expect(system.stable).toContain('sales inbox, not a customer-facing business inbox')
    expect(system.dynamic).toContain("Today's date: 2026-08-14")
  })

  it('grounds the Zanzibar value-question regression in approved product knowledge without owner review', () => {
    const system = buildSalesResponseSystem(
      'base', undefined, '2026-08-14', context,
      classifySalesReplyIntent("Hello, we don't understand your advantages.")
    )
    expect(system.stable).toContain('SALES REPLY INTENT: value_proposition_question')
    expect(system.stable).toContain('REQUIRED NEXT ACTION: ANSWER_AND_PROPOSE_WORK')
    expect(system.stable).toContain('helps owner-operated businesses keep customer conversations moving')
    expect(system.stable).toContain('Do not use hold_for_human or escalate_to_team for an ordinary value')
    expect(system.stable).toContain('Do not introduce price unless the prospect asked about price')
    expect(system.stable).toContain(`Price: $${CAYE_STANDARD_MONTHLY_PRICE_USD}/month flat`)
  })
})
