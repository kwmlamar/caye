import type { EvidenceRef } from '@/lib/freight/types'

/**
 * Epistemic vocabulary, deliberately identical to
 * `lib/operational-intelligence/brief.ts`. An invoice proposal is a money
 * document: every number on it must say whether it was READ from evidence,
 * DERIVED from evidence, or is simply not established.
 */
export type ProposalClaimKind = 'fact' | 'inference' | 'unknown'

export interface ProposalProvenance {
  sourceSystem: 'caye' | 'bedrock'
  authority: 'workspace_evidence' | 'external_authoritative'
  sourceEntityType: string
  sourceEntityId: string
  workspaceId: string
  field?: string
}

export interface ProposalClaim {
  kind: ProposalClaimKind
  text: string
  provenance: ProposalProvenance[]
}

/** One estimate line item this proposal line was traced back to. */
export interface EstimateBasis {
  estimateId: string
  estimateNumber: string | null
  sectionId: string
  sectionName: string
  lineItemId: string
  lineItemDescription: string | null
  estimatedQuantity: number
  estimatedAmount: number
}

export interface ProposalLine {
  description: string | null
  quantity: number | null
  unitPrice: number | null
  /** The amount this line contributes. Null when it cannot be established. */
  extendedPrice: number | null
  /** True when extendedPrice was computed from quantity x unitPrice rather than read. */
  extendedPriceDerived: boolean
  /** The estimate line this was traced to, when exactly one matched. */
  estimateBasis: EstimateBasis | null
  provenance: ProposalProvenance[]
}

export interface ReconciliationResult {
  /** Sum of every line's extendedPrice. Null when any line is unpriced. */
  linesTotal: number | null
  unpricedLineCount: number
  /** linesTotal + tax + shipping. Null when linesTotal is null. */
  computedTotal: number | null
  /** Components absent from evidence and treated as zero to compute a total. */
  assumedZero: Array<'tax' | 'shipping'>
  statedSubtotal: number | null
  statedTotal: number | null
  /** statedSubtotal - linesTotal. Null when either side is unknown. */
  subtotalVariance: number | null
  /** statedTotal - computedTotal. Null when either side is unknown. */
  totalVariance: number | null
  /** True only when the arithmetic was fully checkable and it agreed. */
  balanced: boolean
  /** Operator-safe descriptions of what did not reconcile. */
  issues: string[]
}

/**
 * Never includes anything meaning "send". A proposal is an input to a human
 * decision; the existing freight approval path owns delivery.
 */
export type ProposalReadiness =
  /** Fully grounded and internally consistent — a person can review and approve. */
  | 'READY_FOR_REVIEW'
  /** Grounded enough to show, but something specific must be answered first. */
  | 'NEEDS_INPUT'
  /** Not enough verified evidence to propose money at all. */
  | 'INSUFFICIENT_EVIDENCE'

export interface EstimateReference {
  estimateId: string
  estimateNumber: string | null
  projectId: string | null
  status: string | null
  subtotal: number
  totalAmount: number
  /** How many proposal lines were traced to a line item on this estimate. */
  linesTraced: number
  /** How many proposal lines could not be traced to exactly one line item. */
  linesUntraced: number
}

export interface InvoiceProposal {
  workspaceId: string
  generatedAt: string
  businessName: string
  /** Who the document would be addressed to, when it can be established. */
  billTo: string | null
  freightProvider: string | null
  dockReceiptNumber: string
  shipmentReference: string | null
  vendor: string | null
  purchaseDate: string | null
  purchaseReferences: string[]
  currency: string | null
  lines: ProposalLine[]
  subtotal: number | null
  tax: number | null
  shipping: number | null
  total: number | null
  reconciliation: ReconciliationResult
  estimateReference: EstimateReference | null
  readiness: ProposalReadiness
  /** Operator-safe sentences describing exactly what stops this being ready. */
  blockingReasons: string[]
  claims: ProposalClaim[]
  /** Ids of every purchase-evidence record this proposal was built from. */
  evidenceIds: string[]
}

export function provenanceFromEvidenceRef(ref: EvidenceRef): ProposalProvenance {
  return {
    sourceSystem: ref.source === 'bedrock' ? 'bedrock' : 'caye',
    authority: ref.source === 'bedrock' ? 'external_authoritative' : 'workspace_evidence',
    sourceEntityType: ref.source === 'bedrock' ? 'receipt' : 'business_artifact',
    sourceEntityId: ref.id,
    workspaceId: ref.workspaceId,
    ...(ref.field ? { field: ref.field } : {}),
  }
}
