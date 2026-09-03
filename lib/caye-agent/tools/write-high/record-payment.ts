import 'server-only'

import {
  createBedrockAdapter,
  createBedrockWriteProvider,
  BedrockConnectionMissingError,
} from '@/lib/domain-adapters/bedrock'
import type { Tool } from '../types'

/**
 * Record that money actually arrived.
 *
 * THE RULE THIS TOOL EXISTS TO ENFORCE
 *
 * The bank is the arbiter, and the bank is in no system. ODS's audit found
 * roughly $94,000 of receivables with no confirmed payment and no instrument
 * anywhere that would say. It also found exactly how the mistake gets made:
 * Island Breeze's client wrote "we will wire the money on Monday", the invoice
 * went out, and twenty-three days later nothing recorded whether the wire
 * landed.
 *
 * So a payments row is a HUMAN ATTESTATION and nothing else. `received_by` is
 * NOT NULL and carries the profile of whoever said it arrived — they are on the
 * record. Caye may draft, chase, age and ask. Caye may not conclude.
 *
 * A client saying they paid is not a payment. Neither is a promise, a screenshot
 * described in a message, or an invoice that has simply gone quiet.
 */

const PAYMENT_METHODS = ['cash', 'check', 'bank_transfer', 'credit_card', 'other'] as const
type PaymentMethod = (typeof PAYMENT_METHODS)[number]

/** ODS says "wire". The ledger says bank_transfer. Translate rather than reject. */
const METHOD_ALIASES: Record<string, PaymentMethod> = {
  wire: 'bank_transfer',
  transfer: 'bank_transfer',
  bank: 'bank_transfer',
  ach: 'bank_transfer',
  card: 'credit_card',
  cheque: 'check',
}

export interface RecordPaymentInput {
  invoice_id: string
  amount: number
  payment_date: string
  payment_method: string
  reference_number?: string
  notes?: string
}

export const recordPayment: Tool<RecordPaymentInput> = {
  name: 'record_payment',
  description:
    'Record that a payment ACTUALLY ARRIVED against an invoice. Only call this when a person has ' +
    'stated money is in the account — never because a client said they would pay, never from a ' +
    'promise, and never because an invoice has gone quiet. If someone says "they said they wired it", ' +
    'do NOT call this: say what is still needed and set a reminder instead. ' +
    'Get invoice_id from get_receivables. "Wire" means bank_transfer. This is staged for explicit ' +
    'confirmation, and whoever confirms is recorded as having attested to it.',
  risk: 'high',
  roles: ['owner', 'founder'],
  modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      invoice_id: { type: 'string', description: 'The invoice id from get_receivables.' },
      amount: { type: 'number', description: 'Amount received. A part payment is normal — use what actually arrived.' },
      payment_date: { type: 'string', description: 'The date the money landed, YYYY-MM-DD. Not the date it was promised.' },
      payment_method: {
        type: 'string',
        description: 'cash, check, bank_transfer, credit_card or other. "Wire" is bank_transfer.',
      },
      reference_number: {
        type: 'string',
        description: 'Bank or cheque reference if known. Worth asking for — it is the only trace back to the bank.',
      },
      notes: { type: 'string', description: 'Anything worth remembering about this payment.' },
    },
    required: ['invoice_id', 'amount', 'payment_date', 'payment_method'],
  },

  async execute(args, ctx) {
    if (!Number.isFinite(args.amount) || args.amount <= 0) {
      return { ok: false, error: 'A payment amount has to be a positive number.' }
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(args.payment_date)) {
      return { ok: false, error: 'Payment date must be YYYY-MM-DD — the day the money landed.' }
    }

    const raw = args.payment_method.trim().toLowerCase()
    const method = (PAYMENT_METHODS as readonly string[]).includes(raw)
      ? (raw as PaymentMethod)
      : METHOD_ALIASES[raw]
    if (!method) {
      return { ok: false, error: `"${args.payment_method}" is not a payment method I can record. Use cash, check, wire, card or other.` }
    }

    let write: Awaited<ReturnType<typeof createBedrockWriteProvider>>
    try {
      write = await createBedrockWriteProvider(ctx.workspaceId)
    } catch (error) {
      if (error instanceof BedrockConnectionMissingError) {
        return { ok: false, error: 'This workspace is not connected to a construction ledger.' }
      }
      return { ok: false, error: error instanceof Error ? error.message : 'Could not reach the ledger.' }
    }

    const receivedBy = write.identityFor(ctx.operatorId).profileId
    if (!receivedBy) {
      return {
        ok: false,
        error:
          'No ledger identity is mapped for you, so this payment cannot be attributed to a real person. ' +
          'Whoever confirms money arrived has to be on the record.',
      }
    }

    // Read the invoice first so the amount can be judged against what is
    // actually outstanding. An overpayment is nearly always a typo or the wrong
    // invoice, and it is much cheaper to catch here than to unpick later --
    // there is no update path to correct it with.
    const adapter = createBedrockAdapter()
    let balanceDue: number | null = null
    let invoiceNumber = 'this invoice'
    try {
      const found = await adapter.getInvoiceWithPayments(ctx.workspaceId, args.invoice_id)
      balanceDue = found.invoice.balanceDue
      invoiceNumber = found.invoice.invoiceNumber ?? invoiceNumber
    } catch {
      return { ok: false, error: 'Could not find that invoice on this workspace. Re-check with get_receivables.' }
    }

    if (balanceDue !== null && args.amount > balanceDue + 0.005) {
      return {
        ok: false,
        error:
          `${invoiceNumber} only has ${balanceDue.toFixed(2)} outstanding and this would record ` +
          `${args.amount.toFixed(2)}. Nothing was written. Check the amount, or whether this belongs to a different invoice.`,
      }
    }

    const result = await write.provider.insertPayment(write.companyId, {
      invoice_id: args.invoice_id,
      payment_date: args.payment_date,
      amount: args.amount,
      payment_method: method,
      reference_number: args.reference_number?.trim() || null,
      notes: args.notes?.trim() || null,
      received_by: receivedBy,
    })

    // The ledger recalculates the invoice on insert via its own trigger, so the
    // honest way to report what happened is to re-read it rather than to
    // describe what was sent.
    let after: { amountPaid: number | null; balanceDue: number | null; status: string | null } | null = null
    try {
      const reread = await adapter.getInvoiceWithPayments(ctx.workspaceId, args.invoice_id)
      after = {
        amountPaid: reread.invoice.amountPaid,
        balanceDue: reread.invoice.balanceDue,
        status: reread.invoice.status,
      }
    } catch {
      after = null
    }

    return {
      ok: result.ok && after !== null,
      data: {
        invoice: invoiceNumber,
        recorded: result.insertedCount === 1,
        amount: args.amount,
        method,
        attributed_to_operator: ctx.operatorId ?? null,
        invoice_now: after,
        audit_recorded: result.auditLogWritten,
        failed: result.failedRows.map((f) => f.error),
        note:
          after === null
            ? 'The payment was submitted but the invoice could not be re-read to confirm. Check before recording it again.'
            : after.balanceDue && after.balanceDue > 0
              ? `Part payment recorded. ${after.balanceDue.toFixed(2)} still outstanding.`
              : 'Recorded. This invoice is now settled in the ledger.',
      },
    }
  },
}
