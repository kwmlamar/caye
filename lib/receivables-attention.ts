import 'server-only'

import {
  createBedrockAdapter,
  type BedrockAdapter,
  type BedrockInvoice,
} from '@/lib/domain-adapters/bedrock'
import { observeAttentionItem, type AttentionPriority } from '@/lib/owner-attention'

/**
 * Outstanding TropiTrack invoices -> owner attention.
 *
 * THE GAP THIS CLOSES
 *
 * ODS's audit: roughly $94,000 of receivables with no confirmed payment, and
 * the company's own tracker shows only $62,733.67 of it -- exactly three of
 * nine. `get_receivables` (read) and `record_payment` (high, human
 * attestation only) both already exist. Nothing ever asks. This is the ask:
 * a sweep that raises unconfirmed invoices into the same owner-attention
 * ledger every other briefing already reads from, so they reach a person
 * through the existing path instead of a fourth, invoice-shaped surface.
 *
 * See briefs/ods-receivables-loop.md ("The Friday ask") for the full design.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * It does not decide whether money arrived -- that is `record_payment`'s job
 * alone, and only a human attestation (a `payments` row) can do it. This
 * module only decides whether the CURRENT, already-real state of an invoice
 * (its balance, and whether anyone has ever confirmed a payment against it)
 * is worth an owner's attention, and hands that off to the ledger that owns
 * notification state. Modelled closely on `lib/domain-attention.ts` -- same
 * shape, same reasoning, different domain.
 */

/**
 * `subject_type` is free text with no CHECK constraint, and callers already
 * use ad-hoc literals ('escalation', 'construction_change', 'booking'). A new
 * type needs no migration -- but it does need to be declared once, here, so
 * two producers cannot key the same thing differently. See
 * `lib/domain-attention.ts`'s `SUBJECT_CONSTRUCTION_CHANGE` for the same rule.
 */
export const SUBJECT_RECEIVABLE = 'receivable'

/**
 * Priority thresholds, in whole days since the invoice was issued.
 *
 * Two tracks, because the two failure modes are not the same size. An
 * invoice with NO payment ever recorded means nobody has confirmed anything
 * against it at all -- that is the exact shape of the audit's $94k. An
 * invoice with a payment already on record but still carrying a balance is a
 * client running late on money that is, at least partly, real and
 * attested-to. The first is worse than the second at any given age, and both
 * still get worse with age -- so each track escalates on its own schedule.
 *
 * A policy table, not a heuristic, so the thresholds are reviewable and
 * changeable in one place -- the way `CONSTRUCTION_ATTENTION_RULES` is.
 */
export const RECEIVABLES_ATTENTION_THRESHOLDS = {
  /** No `payments` row has ever been recorded against this invoice. */
  neverConfirmed: { criticalAfterDays: 45, decisionAfterDays: 14 },
  /** At least one payment is on record, but a balance remains. */
  partiallyConfirmed: { decisionAfterDays: 45, awarenessAfterDays: 14 },
} as const

/** One outstanding invoice, in the only shape this module needs. */
export interface ReceivableInvoice {
  id: string
  invoiceNumber: string | null
  clientName: string | null
  issueDate: string | null
  balanceDue: number
  sentAt: string | null
}

export interface ReceivablesAttentionResult {
  considered: number
  raised: number
  skipped: {
    /** Never sent -- not a receivable yet, and `log_invoice_sent` owns that gap. */
    draft: number
    /** Balance is fully paid off. Not a receivable any more. */
    settled: number
  }
}

/**
 * The subset of `BedrockAdapter` this module actually calls -- narrowed so
 * tests can inject a fake without shaping every other adapter method. Same
 * seam `get-receivables.ts` uses for the same two methods.
 */
type ReceivablesAdapter = Pick<BedrockAdapter, 'listInvoices' | 'getInvoiceWithPayments'>

export interface ReceivablesAttentionDeps {
  getAdapter: () => ReceivablesAdapter
  observe: typeof observeAttentionItem
  now: () => Date
}

const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * Whole days between a stored `YYYY-MM-DD` date and `now`, computed fresh on
 * every call and never persisted -- the same rule `get-receivables.ts`
 * documents at length: the audit found every "days outstanding" counter in
 * ODS's own registers was a number typed once and never touched again, and a
 * stale age reads as current, which is worse than no age at all.
 */
function daysBetween(dateStr: string | null, now: Date): number {
  if (!dateStr) return 0
  const then = new Date(`${dateStr}T00:00:00Z`)
  if (Number.isNaN(then.getTime())) return 0
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  return Math.max(0, Math.floor((today.getTime() - then.getTime()) / MS_PER_DAY))
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * Priority for one outstanding invoice, per `RECEIVABLES_ATTENTION_THRESHOLDS`.
 * `hasConfirmedPayment` picks the track; `daysOutstanding` picks the rung.
 */
export function priorityFor(hasConfirmedPayment: boolean, daysOutstanding: number): AttentionPriority {
  const days = Math.max(daysOutstanding, 0)

  if (!hasConfirmedPayment) {
    const t = RECEIVABLES_ATTENTION_THRESHOLDS.neverConfirmed
    if (days >= t.criticalAfterDays) return 'critical'
    if (days >= t.decisionAfterDays) return 'decision'
    return 'awareness'
  }

  const t = RECEIVABLES_ATTENTION_THRESHOLDS.partiallyConfirmed
  if (days >= t.decisionAfterDays) return 'decision'
  if (days >= t.awarenessAfterDays) return 'awareness'
  return 'routine'
}

/**
 * Actionable, and deliberately agnostic about whether money arrived. Caye can
 * state what SHE has on record (a payment, or none); only a human can say
 * what the bank shows, and this must never read as Caye concluding that for
 * them. See briefs/ods-receivables-loop.md: "The bank is the arbiter, and the
 * bank is in no system."
 */
function nextActionFor(hasConfirmedPayment: boolean): string {
  return hasConfirmedPayment
    ? 'A payment is on record but a balance remains. Check the bank for the rest and tell me either way.'
    : 'No payment is on record for this one. Check the bank and tell me either way.'
}

function labelFor(invoice: ReceivableInvoice): string {
  return invoice.clientName?.trim() || invoice.invoiceNumber?.trim() || invoice.id
}

/**
 * "Off the Reef: $17,575.75 outstanding, 63 days, no payment ever recorded"
 *
 * The balance and age are in the title rather than only in the fingerprint,
 * because an owner reading a briefing line should not have to open anything
 * to know what this is asking about.
 */
export function titleFor(invoice: ReceivableInvoice, hasConfirmedPayment: boolean, daysOutstanding: number): string {
  const status = hasConfirmedPayment ? 'partial payment on record' : 'no payment ever recorded'
  return `${labelFor(invoice)}: $${invoice.balanceDue.toFixed(2)} outstanding, ${daysOutstanding} days, ${status}`
}

/**
 * Only the fields whose change should re-earn the owner's attention:
 * the balance still owed, and whether a payment has EVER been recorded.
 *
 * Age is deliberately excluded. If age were in the fingerprint, every
 * outstanding invoice would re-earn attention every single day it ages --
 * which trains the owner to ignore the ledger, the exact failure it exists
 * to prevent. An invoice sits quietly until its balance changes (a payment
 * landed, partial or full) or it goes from unconfirmed to confirmed; getting
 * one more day older is not news.
 */
export function fingerprintPartsFor(invoice: ReceivableInvoice, hasConfirmedPayment: boolean): unknown[] {
  return [round2(invoice.balanceDue), hasConfirmedPayment]
}

/**
 * Raise owner attention for one workspace's outstanding invoices.
 *
 * WHY THIS IS SAFE TO RUN EVERY 30 MINUTES EVEN THOUGH THE ASK SHOULD LAND
 * WEEKLY: `observeAttentionItem` keys on (workspace, subject_type,
 * subject_id) and only moves `last_changed_at` when the fingerprint changes
 * (see `fingerprintPartsFor` -- age is excluded on purpose). Re-running this
 * sweep on the construction ledger's existing 30-minute cadence updates the
 * same row in place and changes nothing an owner would see, right up until an
 * invoice's balance or confirmation status actually moves. Weekly cadence is
 * therefore a property of what changes, not of a timer -- no schedule table,
 * no last-run cursor, nothing that could drift out of sync with the ledger
 * that actually gates notification. The read cost (one `listInvoices` plus
 * one `getInvoiceWithPayments` per outstanding invoice) is the same shape
 * `get_receivables` already pays on demand, and at ODS's volume (single-digit
 * to low-dozens invoices) that is cheap enough to simply not special-case.
 */
export async function raiseReceivablesAttention(args: {
  workspaceId: string
  deps?: Partial<ReceivablesAttentionDeps>
}): Promise<ReceivablesAttentionResult> {
  const getAdapter = args.deps?.getAdapter ?? createBedrockAdapter
  const observe = args.deps?.observe ?? observeAttentionItem
  const now = args.deps?.now ?? (() => new Date())

  const adapter = getAdapter()
  const asOf = now()

  const invoices: BedrockInvoice[] = await adapter.listInvoices(args.workspaceId)
  const sent = invoices.filter((invoice) => invoice.sentAt !== null)

  const result: ReceivablesAttentionResult = {
    considered: sent.length,
    raised: 0,
    skipped: { draft: invoices.length - sent.length, settled: 0 },
  }

  for (const invoice of sent) {
    if (invoice.balanceDue <= 0) {
      result.skipped.settled++
      continue
    }

    const { payments } = await adapter.getInvoiceWithPayments(args.workspaceId, invoice.id)
    const hasConfirmedPayment = payments.length > 0
    const daysOutstanding = daysBetween(invoice.issueDate, asOf)
    const receivable: ReceivableInvoice = {
      id: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      clientName: invoice.clientName,
      issueDate: invoice.issueDate,
      balanceDue: invoice.balanceDue,
      sentAt: invoice.sentAt,
    }

    await observe({
      workspaceId: args.workspaceId,
      subjectType: SUBJECT_RECEIVABLE,
      subjectId: invoice.id,
      title: titleFor(receivable, hasConfirmedPayment, daysOutstanding),
      priority: priorityFor(hasConfirmedPayment, daysOutstanding),
      nextAction: nextActionFor(hasConfirmedPayment),
      fingerprintParts: fingerprintPartsFor(receivable, hasConfirmedPayment),
      // Nobody is blocked waiting on Caye here, and Caye cannot resolve this
      // herself -- only a human attestation (record_payment) can. Same
      // reasoning `domain-attention.ts` uses for a source-system change.
      blockedOnOperator: false,
      resolvableAutonomously: false,
    })
    result.raised++
  }

  return result
}
