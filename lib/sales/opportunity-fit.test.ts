import { describe, expect, it } from 'vitest'
import { deriveSalesWorkOpportunity } from './opportunity-fit'

describe('Sales work opportunity capability fit', () => {
  it('persists only a direct, evidence-backed inbox need', () => {
    const opportunity = deriveSalesWorkOpportunity("We're overwhelmed and need help responding to customer inquiries.")
    expect(opportunity).toMatchObject({
      capabilityKey: 'customer_inbox_response', confidence: 'high',
      inference: 'Caye could help by responding to customer inquiries.',
    })
    expect(opportunity?.observedFact).toContain('need help responding to customer inquiries')
  })

  it('does not infer work from generic interest or an industry label', () => {
    expect(deriveSalesWorkOpportunity('How much does Caye cost?')).toBeNull()
    expect(deriveSalesWorkOpportunity('We run a busy tour company.')).toBeNull()
  })
})
