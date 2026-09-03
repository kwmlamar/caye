import type { BedrockEstimate } from '@/lib/domain-adapters/bedrock/types'
import { rankPurchaseEvidence } from '@/lib/freight/matching'
import type { FreightRequest, PurchaseEvidence, RankedPurchaseEvidence } from '@/lib/freight/types'
import { buildInvoiceProposal } from './build'
import type { InvoiceProposal } from './types'

/**
 * The reads a proposal needs, as an interface rather than a Supabase client.
 *
 * Everything behind this is read-only by construction: there is no write
 * member to implement, so no caller of this module can persist or send.
 */
export interface InvoiceProposalSource {
  loadFreightRequest(input: { workspaceId: string; conversationId: string }): Promise<{ request: FreightRequest; requestMessageId: string } | null>
  loadPurchaseEvidence(input: { workspaceId: string }): Promise<PurchaseEvidence[]>
  loadBusinessName(input: { workspaceId: string }): Promise<string>
  loadEstimate(input: { workspaceId: string; estimateId: string }): Promise<BedrockEstimate | null>
}

export type ComposeInvoiceProposalResult =
  | { outcome: 'NOT_A_FREIGHT_REQUEST' }
  | { outcome: 'NO_MATCH'; request: FreightRequest; candidates: RankedPurchaseEvidence[] }
  | { outcome: 'AMBIGUOUS'; request: FreightRequest; candidates: RankedPurchaseEvidence[] }
  | { outcome: 'PROPOSED'; request: FreightRequest; requestMessageId: string; proposal: InvoiceProposal; usedEvidence: RankedPurchaseEvidence[] }

/**
 * Selects the evidence a consolidation covers.
 *
 * `detectFreightRequest` has always reported `consolidationMentioned` and
 * nothing read it, so a consolidated shipment silently produced a document for
 * one receipt. When the request says consolidation, every independently
 * high-confidence candidate is included; otherwise only the single selection.
 */
function selectEvidence(request: FreightRequest, ranked: RankedPurchaseEvidence[], selection: RankedPurchaseEvidence): RankedPurchaseEvidence[] {
  if (!request.consolidationMentioned) return [selection]
  const high = ranked.filter((candidate) => candidate.confidence === 'HIGH')
  return high.some((candidate) => candidate.evidence.id === selection.evidence.id) ? high : [selection, ...high]
}

export async function composeInvoiceProposal(input: {
  workspaceId: string
  conversationId: string
  /** An explicitly chosen Bedrock estimate to trace purchased items against. */
  estimateId?: string | null
  source: InvoiceProposalSource
  now?: Date
}): Promise<ComposeInvoiceProposalResult> {
  const detected = await input.source.loadFreightRequest({ workspaceId: input.workspaceId, conversationId: input.conversationId })
  if (!detected || !detected.request.isFreightDocumentRequest || !detected.request.dockReceiptNumber) {
    return { outcome: 'NOT_A_FREIGHT_REQUEST' }
  }

  const evidence = (await input.source.loadPurchaseEvidence({ workspaceId: input.workspaceId }))
    .filter((record) => record.workspaceId === input.workspaceId)
  const match = rankPurchaseEvidence(detected.request, evidence)

  if (!match.selection) {
    return { outcome: match.status === 'AMBIGUOUS' ? 'AMBIGUOUS' : 'NO_MATCH', request: detected.request, candidates: match.candidates }
  }

  const usedEvidence = selectEvidence(detected.request, match.candidates, match.selection)
  const [businessName, estimate] = await Promise.all([
    input.source.loadBusinessName({ workspaceId: input.workspaceId }),
    input.estimateId ? input.source.loadEstimate({ workspaceId: input.workspaceId, estimateId: input.estimateId }) : Promise.resolve(null),
  ])

  const proposal = buildInvoiceProposal({
    workspaceId: input.workspaceId,
    businessName,
    request: detected.request,
    evidence: usedEvidence.map((candidate) => candidate.evidence),
    estimate,
    now: input.now,
  })

  return { outcome: 'PROPOSED', request: detected.request, requestMessageId: detected.requestMessageId, proposal, usedEvidence }
}
