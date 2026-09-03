import type { BedrockEstimate } from '@/lib/domain-adapters/bedrock/types'
import type { FreightRequest, PurchaseEvidence } from '@/lib/freight/types'
import { verifiedLineTotal } from '@/lib/freight/document'
import { flattenEstimateLines, matchEstimateLine, type EstimateLineRef } from './estimate-basis'
import { reconcileAmounts } from './reconcile'
import {
  provenanceFromEvidenceRef,
  type EstimateReference,
  type InvoiceProposal,
  type ProposalClaim,
  type ProposalLine,
  type ProposalProvenance,
} from './types'

export interface BuildInvoiceProposalInput {
  workspaceId: string
  businessName: string
  request: FreightRequest
  /**
   * Every purchase-evidence record this proposal draws on. More than one is
   * the normal case for a consolidation — `detectFreightRequest` has always
   * reported `consolidationMentioned`, and nothing consumed it.
   */
  evidence: PurchaseEvidence[]
  /** The authoritative Bedrock estimate for this work, when one is resolved. */
  estimate?: BedrockEstimate | null
  now?: Date
}

const fact = (text: string, provenance: ProposalProvenance[]): ProposalClaim => ({ kind: 'fact', text, provenance })
const inference = (text: string, provenance: ProposalProvenance[]): ProposalClaim => ({ kind: 'inference', text, provenance })
const unknown = (text: string, workspaceId: string): ProposalClaim => ({
  kind: 'unknown',
  text,
  provenance: [{ sourceSystem: 'caye', authority: 'workspace_evidence', sourceEntityType: 'invoice_proposal', sourceEntityId: 'unresolved', workspaceId }],
})

function sumOrNull(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null)
  if (present.length === 0) return null
  return Math.round(present.reduce((sum, value) => sum + value * 100, 0)) / 100
}

function distinct(values: Array<string | null>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))]
}

/**
 * Build a grounded invoice proposal from a detected freight request and the
 * purchase evidence behind it.
 *
 * Pure and deterministic on purpose: no I/O, no clock beyond an injected
 * `now`, no writes anywhere. Every number carries provenance, every gap is
 * named, and the result never expresses an intent to send.
 */
export function buildInvoiceProposal(input: BuildInvoiceProposalInput): InvoiceProposal {
  const { workspaceId, businessName, request } = input
  const generatedAt = (input.now ?? new Date()).toISOString()

  const dockReceiptNumber = request.dockReceiptNumber
  if (!dockReceiptNumber) {
    throw new Error('Dock receipt number is required before an invoice proposal can be built')
  }
  for (const record of input.evidence) {
    if (record.workspaceId !== workspaceId) {
      throw new Error(`Cross-workspace purchase evidence rejected for ${record.id}`)
    }
  }
  const estimate = input.estimate ?? null
  if (estimate && estimate.workspaceId !== workspaceId) {
    throw new Error(`Cross-workspace estimate rejected for ${estimate.id}`)
  }

  const claims: ProposalClaim[] = []
  const blockingReasons: string[] = []
  const estimateLines: EstimateLineRef[] = estimate ? flattenEstimateLines(estimate) : []

  let linesTraced = 0
  let linesUntraced = 0
  let ambiguousBasisCount = 0

  const lines: ProposalLine[] = input.evidence.flatMap((record) =>
    record.lines.map((line) => {
      const provenance = line.provenance.map(provenanceFromEvidenceRef)
      const extendedPrice = verifiedLineTotal(line)
      const extendedPriceDerived = line.extendedPrice === null && extendedPrice !== null

      let basis: EstimateLineRef | null = null
      if (estimateLines.length > 0) {
        const matched = matchEstimateLine(line.description, estimateLines)
        basis = matched.basis
        if (matched.ambiguous) ambiguousBasisCount += 1
        if (basis) linesTraced += 1
        else linesUntraced += 1
      }

      if (extendedPrice === null) {
        claims.push(unknown(`No amount is established for "${line.description ?? 'an unnamed item'}".`, workspaceId))
      } else if (extendedPriceDerived) {
        claims.push(inference(
          `"${line.description ?? 'An unnamed item'}" is valued at ${extendedPrice} by multiplying the quantity and unit price read from the purchase evidence.`,
          provenance,
        ))
      } else {
        claims.push(fact(`"${line.description ?? 'An unnamed item'}" is priced at ${extendedPrice} in the purchase evidence.`, provenance))
      }

      if (basis) {
        claims.push(inference(
          `"${line.description ?? 'An unnamed item'}" matches estimate line "${basis.lineItemDescription ?? basis.lineItemId}" in section ${basis.sectionName}.`,
          [...provenance, {
            sourceSystem: 'bedrock',
            authority: 'external_authoritative',
            sourceEntityType: 'estimate',
            sourceEntityId: basis.estimateId,
            workspaceId,
            field: `sections/${basis.sectionId}/lineItems/${basis.lineItemId}`,
          }],
        ))
      }

      return { description: line.description, quantity: line.quantity, unitPrice: line.unitPrice, extendedPrice, extendedPriceDerived, estimateBasis: basis, provenance }
    }),
  )

  const currencies = distinct(input.evidence.map((record) => record.currency))
  const currency = currencies.length === 1 ? currencies[0] : null
  if (currencies.length > 1) {
    blockingReasons.push(`The purchase evidence mixes ${currencies.join(' and ')}, so a single invoice currency cannot be established.`)
    claims.push(unknown('The invoice currency is not established because the purchase evidence disagrees.', workspaceId))
  } else if (currency === null) {
    blockingReasons.push('No currency is stated anywhere in the purchase evidence.')
    claims.push(unknown('The invoice currency is not established.', workspaceId))
  }

  const evidenceProvenance = input.evidence.flatMap((record) => record.provenance.map(provenanceFromEvidenceRef))
  const subtotal = sumOrNull(input.evidence.map((record) => record.subtotal))
  const tax = sumOrNull(input.evidence.map((record) => record.tax))
  const shipping = sumOrNull(input.evidence.map((record) => record.shipping))
  const total = sumOrNull(input.evidence.map((record) => record.total))

  const reconciliation = reconcileAmounts({
    lineTotals: lines.map((line) => line.extendedPrice),
    subtotal,
    tax,
    shipping,
    total,
  })
  for (const issue of reconciliation.issues) blockingReasons.push(issue)
  if (reconciliation.balanced) {
    claims.push(fact(
      `The item amounts, tax and shipping reconcile to the stated total of ${reconciliation.statedTotal}.`,
      evidenceProvenance,
    ))
  }
  for (const component of reconciliation.assumedZero) {
    claims.push(inference(`No ${component} is stated in the purchase evidence, so it is treated as zero.`, evidenceProvenance))
  }

  const purchaseDates = distinct(input.evidence.map((record) => record.purchaseDate))
  const purchaseDate = purchaseDates.length === 1 ? purchaseDates[0] : null
  if (purchaseDates.length > 1) {
    claims.push(inference(
      `The purchases span ${purchaseDates.length} dates, so no single purchase date is stated on the proposal.`,
      evidenceProvenance,
    ))
  }

  const vendors = distinct(input.evidence.map((record) => record.vendor))
  const vendor = vendors.length === 1 ? vendors[0] : null
  if (vendor) claims.push(fact(`The goods were purchased from ${vendor}.`, evidenceProvenance))
  else if (vendors.length > 1) claims.push(fact(`The goods were purchased from ${vendors.length} suppliers: ${vendors.join(', ')}.`, evidenceProvenance))
  else {
    blockingReasons.push('No supplier is named in the purchase evidence.')
    claims.push(unknown('The supplier is not established.', workspaceId))
  }

  const billTo = request.freightProvider ?? request.senderName
  if (billTo) {
    claims.push(inference(
      `The document would be addressed to ${billTo}, taken from the name on the request rather than from a confirmed customer record.`,
      [{ sourceSystem: 'caye', authority: 'workspace_evidence', sourceEntityType: 'freight_request', sourceEntityId: dockReceiptNumber, workspaceId }],
    ))
  } else {
    blockingReasons.push('There is no name on the request to address the document to.')
  }

  if (request.consolidationMentioned && input.evidence.length === 1) {
    blockingReasons.push('The request mentions a consolidation, but only one purchase was matched to it.')
    claims.push(unknown('Whether other purchases belong on this shipment is not established.', workspaceId))
  }

  let estimateReference: EstimateReference | null = null
  if (estimate) {
    estimateReference = {
      estimateId: estimate.id,
      estimateNumber: estimate.number,
      projectId: estimate.projectId,
      status: estimate.status,
      subtotal: estimate.subtotal,
      totalAmount: estimate.totalAmount,
      linesTraced,
      linesUntraced,
    }
    claims.push(fact(
      `Estimate ${estimate.number ?? estimate.id} totals ${estimate.totalAmount} and is ${estimate.status ?? 'of unknown status'}.`,
      [{ sourceSystem: 'bedrock', authority: 'external_authoritative', sourceEntityType: 'estimate', sourceEntityId: estimate.id, workspaceId }],
    ))
    if (linesUntraced > 0) {
      claims.push(inference(
        `${linesUntraced} of ${lines.length} purchased items could not be traced to a single estimate line.`,
        [{ sourceSystem: 'bedrock', authority: 'external_authoritative', sourceEntityType: 'estimate', sourceEntityId: estimate.id, workspaceId }],
      ))
    }
    if (ambiguousBasisCount > 0) {
      blockingReasons.push(`${ambiguousBasisCount} purchased items match more than one estimate line equally well.`)
    }
  } else {
    claims.push(unknown('No estimate has been resolved for this shipment, so the purchased items are not traced back to estimated work.', workspaceId))
  }

  const readiness = lines.length === 0 || reconciliation.linesTotal === null
    ? 'INSUFFICIENT_EVIDENCE'
    : blockingReasons.length > 0
      ? 'NEEDS_INPUT'
      : 'READY_FOR_REVIEW'

  return {
    workspaceId,
    generatedAt,
    businessName,
    billTo,
    freightProvider: request.freightProvider,
    dockReceiptNumber,
    shipmentReference: request.shipmentReference,
    vendor,
    purchaseDate,
    purchaseReferences: distinct(input.evidence.flatMap((record) => [
      ...record.referenceNumbers, record.orderNumber, record.receiptNumber, record.poNumber,
    ])),
    currency,
    lines,
    subtotal,
    tax,
    shipping,
    total,
    reconciliation,
    estimateReference,
    readiness,
    blockingReasons,
    claims,
    evidenceIds: input.evidence.map((record) => record.id),
  }
}
