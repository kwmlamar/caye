import { describe, expect, it } from 'vitest'
import { KING_OCEAN_FIXTURE } from '@/lib/freight/fixture'
import type { FreightRequest, PurchaseEvidence } from '@/lib/freight/types'
import { composeInvoiceProposal, type InvoiceProposalSource } from './compose'

const WORKSPACE = KING_OCEAN_FIXTURE.evidence.workspaceId
const NOW = new Date('2026-09-02T00:00:00Z')

const evidence = (overrides: Partial<PurchaseEvidence> = {}): PurchaseEvidence => ({ ...KING_OCEAN_FIXTURE.evidence, ...overrides })

function source(overrides: Partial<InvoiceProposalSource> & { request?: FreightRequest | null; evidence?: PurchaseEvidence[] } = {}): InvoiceProposalSource {
  return {
    async loadFreightRequest() {
      const request = overrides.request === undefined ? KING_OCEAN_FIXTURE.request : overrides.request
      return request ? { request, requestMessageId: 'msg-request-1' } : null
    },
    async loadPurchaseEvidence() { return overrides.evidence ?? [evidence()] },
    async loadBusinessName() { return 'ODS Construction' },
    async loadEstimate() { return null },
    ...(overrides.loadEstimate ? { loadEstimate: overrides.loadEstimate } : {}),
  }
}

const compose = (input: Partial<Parameters<typeof composeInvoiceProposal>[0]> = {}) => composeInvoiceProposal({
  workspaceId: WORKSPACE,
  conversationId: 'conversation-1',
  source: source(),
  now: NOW,
  ...input,
})

describe('invoice proposal composition', () => {
  it('proposes an invoice for a matched freight request', async () => {
    const result = await compose()
    expect(result.outcome).toBe('PROPOSED')
    if (result.outcome !== 'PROPOSED') return
    expect(result.proposal.readiness).toBe('READY_FOR_REVIEW')
    expect(result.requestMessageId).toBe('msg-request-1')
  })

  it('does nothing for a conversation that is not a freight request', async () => {
    const notFreight = { ...KING_OCEAN_FIXTURE.request, isFreightDocumentRequest: false }
    expect((await compose({ source: source({ request: notFreight }) })).outcome).toBe('NOT_A_FREIGHT_REQUEST')
  })

  it('does nothing when the freight request has no dock receipt number', async () => {
    const noDock = { ...KING_OCEAN_FIXTURE.request, dockReceiptNumber: null }
    expect((await compose({ source: source({ request: noDock }) })).outcome).toBe('NOT_A_FREIGHT_REQUEST')
  })

  it('does nothing when the conversation cannot be read', async () => {
    expect((await compose({ source: source({ request: null }) })).outcome).toBe('NOT_A_FREIGHT_REQUEST')
  })

  it('reports no match rather than proposing money with nothing behind it', async () => {
    const unrelated = evidence({ id: 'unrelated', referenceNumbers: [], orderNumber: null, purchaseDate: null, lines: [], total: null })
    const result = await compose({ source: source({ evidence: [unrelated] }) })
    expect(result.outcome).toBe('NO_MATCH')
  })

  it('reports ambiguity rather than picking one of two equal matches', async () => {
    const result = await compose({ source: source({ evidence: [evidence({ id: 'a' }), evidence({ id: 'b' })] }) })
    expect(result.outcome).toBe('AMBIGUOUS')
  })

  it('drops evidence belonging to another workspace before ranking it', async () => {
    const foreign = evidence({ id: 'foreign', workspaceId: 'workspace-other' })
    const result = await compose({ source: source({ evidence: [evidence(), foreign] }) })
    expect(result.outcome).toBe('PROPOSED')
    if (result.outcome !== 'PROPOSED') return
    expect(result.proposal.evidenceIds).toEqual(['receipt-home-depot-001'])
  })

  it('includes every high-confidence purchase when the request mentions a consolidation', async () => {
    const second = evidence({
      id: 'receipt-2',
      lines: [{ description: 'Concrete mix', quantity: 5, unitPrice: 8, extendedPrice: 40, provenance: [{ source: 'email', id: 'msg-2', workspaceId: WORKSPACE }] }],
      subtotal: 40, tax: 0, shipping: 0, total: 40,
    })
    const consolidation = { ...KING_OCEAN_FIXTURE.request, consolidationMentioned: true }
    const result = await compose({ source: source({ request: consolidation, evidence: [evidence(), second] }) })
    expect(result.outcome).toBe('PROPOSED')
    if (result.outcome !== 'PROPOSED') return
    expect(result.proposal.evidenceIds.sort()).toEqual(['receipt-2', 'receipt-home-depot-001'])
  })

  it('only asks the domain for an estimate when one was named', async () => {
    const asked: string[] = []
    const withEstimate = source({ async loadEstimate({ estimateId }) { asked.push(estimateId); return null } })
    await compose({ source: withEstimate })
    expect(asked).toEqual([])
    await compose({ source: withEstimate, estimateId: 'estimate-1' })
    expect(asked).toEqual(['estimate-1'])
  })
})
