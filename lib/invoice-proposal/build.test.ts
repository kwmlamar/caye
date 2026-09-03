import { describe, expect, it } from 'vitest'
import type { BedrockEstimate } from '@/lib/domain-adapters/bedrock/types'
import { KING_OCEAN_FIXTURE } from '@/lib/freight/fixture'
import type { PurchaseEvidence } from '@/lib/freight/types'
import { buildInvoiceProposal } from './build'

const WORKSPACE = KING_OCEAN_FIXTURE.evidence.workspaceId
const NOW = new Date('2026-09-02T00:00:00Z')

const evidence = (overrides: Partial<PurchaseEvidence> = {}): PurchaseEvidence => ({ ...KING_OCEAN_FIXTURE.evidence, ...overrides })
const request = (overrides: Partial<typeof KING_OCEAN_FIXTURE.request> = {}) => ({ ...KING_OCEAN_FIXTURE.request, ...overrides })

const estimate = (overrides: Partial<BedrockEstimate> = {}): BedrockEstimate => ({
  sourceSystem: 'bedrock',
  authority: 'external_authoritative',
  sourceEntityType: 'estimate',
  sourceEntityId: 'estimate-1',
  workspaceId: WORKSPACE,
  companyId: 'company-1',
  id: 'estimate-1',
  projectId: 'project-1',
  number: 'EST-1',
  name: 'Eleuthera villa',
  title: null,
  clientNameSnapshot: null,
  status: 'approved',
  issueDate: '2026-08-01',
  subtotal: 1000,
  totalAmount: 1100,
  sections: [{
    id: 'section-1',
    name: 'Framing',
    lineItems: [
      { id: 'line-1', description: 'Pressure-treated lumber for deck framing', quantity: 20, unit: 'ea', totalAmount: 400 },
      { id: 'line-2', description: 'Roofing fasteners', quantity: 10, unit: 'box', totalAmount: 140 },
    ],
  }],
  ...overrides,
})

const build = (input: Partial<Parameters<typeof buildInvoiceProposal>[0]> = {}) => buildInvoiceProposal({
  workspaceId: WORKSPACE,
  businessName: 'ODS Construction',
  request: request(),
  evidence: [evidence()],
  now: NOW,
  ...input,
})

describe('grounded invoice proposal', () => {
  it('is ready for review when the evidence is complete and reconciles', () => {
    const proposal = build()
    expect(proposal.readiness).toBe('READY_FOR_REVIEW')
    expect(proposal.blockingReasons).toEqual([])
    expect(proposal.reconciliation.balanced).toBe(true)
    expect(proposal.total).toBe(522.5)
    expect(proposal.currency).toBe('USD')
    expect(proposal.evidenceIds).toEqual(['receipt-home-depot-001'])
  })

  it('never proposes money without naming the evidence behind every line', () => {
    const proposal = build()
    expect(proposal.lines).toHaveLength(2)
    for (const line of proposal.lines) {
      expect(line.provenance.length).toBeGreaterThan(0)
      for (const source of line.provenance) expect(source.workspaceId).toBe(WORKSPACE)
    }
  })

  it('refuses purchase evidence from another workspace', () => {
    expect(() => build({ evidence: [evidence({ workspaceId: 'workspace-other' })] }))
      .toThrow(/Cross-workspace purchase evidence/)
  })

  it('refuses an estimate from another workspace', () => {
    expect(() => build({ estimate: estimate({ workspaceId: 'workspace-other' }) }))
      .toThrow(/Cross-workspace estimate/)
  })

  it('requires a dock receipt number', () => {
    expect(() => build({ request: request({ dockReceiptNumber: null }) })).toThrow(/Dock receipt number is required/)
  })

  it('marks a computed line amount as derived rather than read', () => {
    const proposal = build({
      evidence: [evidence({
        lines: [{ description: 'Lumber', quantity: 4, unitPrice: 10, extendedPrice: null, provenance: KING_OCEAN_FIXTURE.evidence.lines[0].provenance }],
        subtotal: 40, tax: 0, shipping: 0, total: 40,
      })],
    })
    expect(proposal.lines[0].extendedPrice).toBe(40)
    expect(proposal.lines[0].extendedPriceDerived).toBe(true)
    expect(proposal.claims.some((claim) => claim.kind === 'inference' && claim.text.includes('multiplying'))).toBe(true)
  })

  it('blocks on a total that does not reconcile instead of printing it', () => {
    const proposal = build({ evidence: [evidence({ total: 999 })] })
    expect(proposal.readiness).toBe('NEEDS_INPUT')
    expect(proposal.reconciliation.balanced).toBe(false)
    expect(proposal.blockingReasons.join(' ')).toContain('states a total of 999')
  })

  it('has insufficient evidence when a line has no establishable amount', () => {
    const proposal = build({
      evidence: [evidence({
        lines: [{ description: 'Lumber', quantity: null, unitPrice: null, extendedPrice: null, provenance: [] }],
      })],
    })
    expect(proposal.readiness).toBe('INSUFFICIENT_EVIDENCE')
  })

  it('has insufficient evidence when nothing was matched at all', () => {
    expect(build({ evidence: [] }).readiness).toBe('INSUFFICIENT_EVIDENCE')
  })

  it('blocks when the evidence disagrees about currency', () => {
    const proposal = build({ evidence: [evidence({ id: 'a' }), evidence({ id: 'b', currency: 'BSD' })] })
    expect(proposal.currency).toBeNull()
    expect(proposal.blockingReasons.join(' ')).toContain('mixes USD and BSD')
  })

  it('aggregates several purchases into one consolidated proposal', () => {
    const second = evidence({
      id: 'receipt-2',
      vendor: 'Home Depot',
      lines: [{ description: 'Concrete mix', quantity: 5, unitPrice: 8, extendedPrice: 40, provenance: [{ source: 'email', id: 'msg-receipt-2', workspaceId: WORKSPACE, field: 'line_items[0]' }] }],
      subtotal: 40, tax: 0, shipping: 0, total: 40,
    })
    const proposal = build({ request: request({ consolidationMentioned: true }), evidence: [evidence(), second] })
    expect(proposal.lines).toHaveLength(3)
    expect(proposal.total).toBe(562.5)
    expect(proposal.reconciliation.balanced).toBe(true)
    expect(proposal.evidenceIds).toEqual(['receipt-home-depot-001', 'receipt-2'])
  })

  it('blocks when a consolidation was requested but only one purchase was matched', () => {
    const proposal = build({ request: request({ consolidationMentioned: true }) })
    expect(proposal.readiness).toBe('NEEDS_INPUT')
    expect(proposal.blockingReasons.join(' ')).toContain('mentions a consolidation')
  })

  it('traces purchased items back to the estimate lines they came from', () => {
    const proposal = build({ estimate: estimate() })
    expect(proposal.estimateReference).toMatchObject({ estimateId: 'estimate-1', estimateNumber: 'EST-1', linesTraced: 2, linesUntraced: 0 })
    expect(proposal.lines[0].estimateBasis?.lineItemId).toBe('line-1')
    expect(proposal.lines[1].estimateBasis?.lineItemId).toBe('line-2')
    expect(proposal.readiness).toBe('READY_FOR_REVIEW')
  })

  it('leaves a purchased item untraced rather than guessing an estimate line', () => {
    const proposal = build({
      evidence: [evidence({ lines: [{ description: 'Site portable toilet rental', quantity: 1, unitPrice: 522.5, extendedPrice: 522.5, provenance: [] }] })],
      estimate: estimate(),
    })
    expect(proposal.lines[0].estimateBasis).toBeNull()
    expect(proposal.estimateReference).toMatchObject({ linesTraced: 0, linesUntraced: 1 })
  })

  it('records that no estimate was resolved rather than staying silent about it', () => {
    const proposal = build()
    expect(proposal.estimateReference).toBeNull()
    expect(proposal.claims.some((claim) => claim.kind === 'unknown' && claim.text.includes('No estimate has been resolved'))).toBe(true)
  })

  it('treats the addressee as an inference from the request, not a confirmed record', () => {
    const proposal = build()
    expect(proposal.billTo).toBe('King Ocean')
    expect(proposal.claims.some((claim) => claim.kind === 'inference' && claim.text.includes('King Ocean'))).toBe(true)
  })

  it('blocks when no supplier is named in the evidence', () => {
    const proposal = build({ evidence: [evidence({ vendor: null })] })
    expect(proposal.blockingReasons.join(' ')).toContain('No supplier is named')
  })

  it('is deterministic for the same inputs', () => {
    expect(JSON.stringify(build({ estimate: estimate() }))).toBe(JSON.stringify(build({ estimate: estimate() })))
  })
})
