import 'server-only'
import { composeInvoiceProposal, type InvoiceProposalSource } from '@/lib/invoice-proposal/compose'
import { createSupabaseInvoiceProposalSource } from '@/lib/invoice-proposal/supabase-source'
import { classifyError, notFound, succeeded } from '../result'
import type { Tool } from '../types'

interface ProposeFreightInvoiceInput {
  conversation_id: string
  estimate_id?: string
}

/**
 * The read tool that closes the autonomy gap on the ODS freight path.
 *
 * Before this, every piece of the estimate-to-invoice workflow was reachable
 * only from the founder dashboard route: Caye herself had no tool that could
 * see a freight request, the purchase evidence behind it, or the estimate it
 * came from. She could not investigate the request at all, let alone say what
 * a grounded invoice for it would look like.
 *
 * Deliberately `risk: 'read'`. It builds a proposal and returns it; it writes
 * nothing, stages nothing, and sends nothing. Generating and sending the
 * actual document remains behind the existing owner-approval path, which is
 * where the conversation-execution claim and the send live.
 */
export const proposeFreightInvoice: Tool<ProposeFreightInvoiceInput> = {
  name: 'propose_freight_invoice',
  description:
    'Work out what an invoice for a freight document request would say, grounded in the dock receipt and the ' +
    'purchase receipts behind it. Optionally traces the purchased items back to a job estimate. Returns the ' +
    'proposed lines and totals, whether the amounts reconcile, and anything that still needs an answer. ' +
    'This only works it out. It does not create or send anything.',
  risk: 'read',
  roles: ['owner', 'founder'],
  modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      conversation_id: { type: 'string', description: 'The conversation containing the freight document request.' },
      estimate_id: { type: 'string', description: 'Optional job estimate to trace the purchased items against.' },
    },
    required: ['conversation_id'],
  },

  async execute(args, ctx) {
    if (!args?.conversation_id || typeof args.conversation_id !== 'string') {
      return notFound('That conversation could not be found.')
    }

    let source: InvoiceProposalSource
    try {
      source = createSupabaseInvoiceProposalSource()
    } catch (error) {
      return classifyError(error, 'INVOICE_PROPOSAL_SOURCE_UNAVAILABLE')
    }

    try {
      const result = await composeInvoiceProposal({
        workspaceId: ctx.workspaceId,
        conversationId: args.conversation_id,
        estimateId: args.estimate_id ?? null,
        source,
      })

      if (result.outcome === 'NOT_A_FREIGHT_REQUEST') {
        return succeeded({ outcome: result.outcome, summary: 'This conversation is not asking for a freight document, so there is nothing to invoice from it.' })
      }

      if (result.outcome === 'NO_MATCH' || result.outcome === 'AMBIGUOUS') {
        return succeeded({
          outcome: result.outcome,
          dock_receipt_number: result.request.dockReceiptNumber,
          summary: result.outcome === 'AMBIGUOUS'
            ? 'More than one purchase fits this dock receipt equally well, so the right one has to be chosen before an invoice can be proposed.'
            : 'No purchase on file matches this dock receipt, so there is nothing verified to invoice from yet.',
          candidates: result.candidates.slice(0, 5).map((candidate) => ({
            evidence_id: candidate.evidence.id,
            vendor: candidate.evidence.vendor,
            purchase_date: candidate.evidence.purchaseDate,
            total: candidate.evidence.total,
            confidence: candidate.confidence,
            reasons: candidate.reasons,
          })),
        })
      }

      const { proposal } = result
      return succeeded({
        outcome: result.outcome,
        readiness: proposal.readiness,
        blocking_reasons: proposal.blockingReasons,
        dock_receipt_number: proposal.dockReceiptNumber,
        bill_to: proposal.billTo,
        vendor: proposal.vendor,
        currency: proposal.currency,
        lines: proposal.lines.map((line) => ({
          description: line.description,
          quantity: line.quantity,
          amount: line.extendedPrice,
          amount_derived: line.extendedPriceDerived,
          estimate_line: line.estimateBasis?.lineItemDescription ?? null,
        })),
        subtotal: proposal.subtotal,
        tax: proposal.tax,
        shipping: proposal.shipping,
        total: proposal.total,
        reconciliation: {
          balanced: proposal.reconciliation.balanced,
          lines_total: proposal.reconciliation.linesTotal,
          computed_total: proposal.reconciliation.computedTotal,
          stated_total: proposal.reconciliation.statedTotal,
          total_variance: proposal.reconciliation.totalVariance,
          issues: proposal.reconciliation.issues,
        },
        estimate: proposal.estimateReference,
        claims: proposal.claims.map((claim) => ({ kind: claim.kind, text: claim.text })),
        evidence_ids: proposal.evidenceIds,
      })
    } catch (error) {
      return classifyError(error, 'INVOICE_PROPOSAL_FAILED')
    }
  },
}
