import 'server-only'
import {
  createBedrockAdapter,
  BedrockConnectionMissingError,
  type BedrockAdapter,
} from '@/lib/domain-adapters/bedrock'
import type { Tool } from '../types'

export interface GetReceivablesInput {
  /** Optional TropiTrack project id to scope the receivables list to a single job. */
  project_id?: string
}

/**
 * The subset of BedrockAdapter this tool actually calls -- narrowed so tests
 * can inject a fake without shaping every other adapter method.
 */
type ReceivablesAdapter = Pick<BedrockAdapter, 'listInvoices' | 'getInvoiceWithPayments'>

const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * Whole days between a stored `YYYY-MM-DD` date and `now`, computed fresh on
 * every call. Never cache or persist this number.
 *
 * The ODS audit is the reason this function exists: every "days outstanding"
 * counter in the company's own registers turned out to be a number someone
 * typed once and never touched again -- the AR tab read 36/6/0 for invoice
 * ages that were actually 63/33/19 by the time anyone looked. A stale age is
 * worse than no age at all because it *reads* as current and nobody
 * double-checks a number that looks plausible. So this is computed at read
 * time from the real date columns, every time get_receivables runs, and
 * nothing about it is ever written back to storage.
 */
function daysBetween(dateStr: string | null, now: Date): number | null {
  if (!dateStr) return null
  const then = new Date(`${dateStr}T00:00:00Z`)
  if (Number.isNaN(then.getTime())) return null
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  return Math.floor((today.getTime() - then.getTime()) / MS_PER_DAY)
}

/**
 * Factory seam: production callers get the real, kernel-bound Bedrock
 * adapter; tests pass a fake implementing only listInvoices/
 * getInvoiceWithPayments (see get-receivables.test.ts). `now` is a second
 * seam for the same reason -- ageing must be computed from a fixed, injected
 * clock in tests, never from the real wall-clock date.
 */
export function makeGetReceivables(
  getAdapter: () => ReceivablesAdapter = createBedrockAdapter,
  now: () => Date = () => new Date()
): Tool<GetReceivablesInput> {
  return {
    name: 'get_receivables',
    description:
      'Who owes ODS money, aged from real TropiTrack invoice dates computed at the moment this runs -- never a stored or cached day count. ' +
      "Separates 'unconfirmed' (an invoice with no payments row at all -- nobody has ever recorded money arriving against it) from 'overdue' (past its due date with a balance still owed). " +
      'These are different problems and are reported separately: collapsing them hides invoices nobody has checked on behind invoices a client is simply late paying. ' +
      "An invoice with even one recorded payment is never 'unconfirmed', even if it is still overdue and only partially paid -- partial payment is normal for ODS's milestone billing. " +
      "A `payments` row is written only by record_payment (high risk) as a human attestation that money was received; this tool never infers a payment from a promise, a client's message, or an invoice's own status. " +
      "The response ALWAYS states, in the data itself, that no bank is connected -- Caye can see what TropiTrack says was invoiced and what a human has confirmed as paid, but never what actually landed in an account. Never imply otherwise when reporting this. " +
      "If `nothing_recorded` is true, NOTHING HAS BEEN ENTERED -- that is not the same as nothing being owed, and must never be reported as 'nothing outstanding' or 'all caught up'. Report the register as empty and offer to record invoices that have already gone out. " +
      'Only invoices that have actually been sent (log_invoice_sent recorded a sent_at) and still carry a balance are included -- drafts and fully-paid invoices are not receivables. ' +
      'Invoices are sorted oldest-unconfirmed-first: that is the order a human should work them in.',
    risk: 'read',
    roles: ['owner', 'founder'],
    modes: ['back-office'],
    inputSchema: {
      type: 'object',
      properties: {
        project_id: {
          type: 'string',
          description: 'Optional TropiTrack project id to scope the receivables list to a single job.',
        },
      },
    },

    async execute(args, ctx) {
      const adapter = getAdapter()
      const asOf = now()

      try {
        const invoices = await adapter.listInvoices(ctx.workspaceId, {
          projectId: args.project_id,
        })

        const outstanding = invoices.filter((invoice) => invoice.sentAt !== null && invoice.balanceDue > 0)

        const rows = await Promise.all(
          outstanding.map(async (invoice) => {
            const { payments } = await adapter.getInvoiceWithPayments(ctx.workspaceId, invoice.id)
            const hasPayment = payments.length > 0
            const daysOutstanding = daysBetween(invoice.issueDate, asOf)
            const daysPastDue = daysBetween(invoice.dueDate, asOf)
            const isOverdue = daysPastDue !== null && daysPastDue > 0 && invoice.balanceDue > 0
            const daysOverdue = isOverdue ? daysPastDue : 0

            return {
              id: invoice.id,
              invoice_number: invoice.invoiceNumber,
              client_name: invoice.clientName,
              project_id: invoice.projectId,
              status: invoice.status,
              issue_date: invoice.issueDate,
              due_date: invoice.dueDate,
              sent_at: invoice.sentAt,
              total_amount: invoice.totalAmount,
              amount_paid: invoice.amountPaid,
              balance_due: invoice.balanceDue,
              days_outstanding: daysOutstanding,
              overdue: isOverdue,
              days_overdue: daysOverdue,
              has_payment_recorded: hasPayment,
              unconfirmed: !hasPayment,
            }
          })
        )

        rows.sort((a, b) => {
          if (a.unconfirmed !== b.unconfirmed) return a.unconfirmed ? -1 : 1
          const aDays = a.days_outstanding ?? -1
          const bDays = b.days_outstanding ?? -1
          return bDays - aDays
        })

        const unconfirmedCount = rows.filter((r) => r.unconfirmed).length
        const overdueCount = rows.filter((r) => r.overdue).length
        const totalOutstandingBalance = Math.round(rows.reduce((sum, r) => sum + r.balance_due, 0) * 100) / 100

        // An empty result is the single most dangerous thing this tool can
        // return, and it is not the same fact as "nothing is owed".
        //
        // At the time of writing the ledger holds ZERO invoice rows against 25
        // projects and 3,883 timesheet entries, while the audit puts roughly
        // $94,178 of payment requests outstanding. Every one of those lives in
        // email and spreadsheets, not here. So a bare `total_outstanding_balance: 0`
        // reads as "you are all caught up" when the truth is "nobody has written
        // any of it down yet" -- the audit's own core failure, handed back to the
        // owner as reassurance. A wrong zero is worse than no answer, because a
        // zero gets believed and nobody re-checks a number that looks clean.
        //
        // So the emptiness is reported as its own explicit fact rather than left
        // to be inferred from a total. `scope` distinguishes the two ways of
        // arriving at zero: nothing recorded for this JOB is ordinary, nothing
        // recorded ANYWHERE means the register itself is empty.
        const nothingRecorded = rows.length === 0
        const scopedToProject = Boolean(args.project_id)

        return {
          ok: true,
          data: {
            as_of: asOf.toISOString(),
            bank_connected: false,
            bank_note:
              'No bank account is connected. This reflects what TropiTrack has invoiced and what a human has confirmed as received -- it is not a bank balance, and Caye cannot see whether money has actually arrived.',
            nothing_recorded: nothingRecorded,
            nothing_recorded_note: nothingRecorded
              ? scopedToProject
                ? 'No invoice has been recorded against this job. That means none has been entered -- it does NOT mean the job is fully paid or that nothing is owed on it. Say that this is what is on record, not what is owed, and offer to record any invoice that has already gone out.'
                : 'No invoice has been recorded at all, so there is nothing here to age. Do NOT report this as "nothing outstanding", "all caught up", or a zero balance -- it means none have been entered yet, not that no money is owed. Say plainly that the register is empty, and offer to record the invoices that have already gone out so they can start being tracked.'
              : null,
            total_invoices: rows.length,
            unconfirmed_count: unconfirmedCount,
            overdue_count: overdueCount,
            total_outstanding_balance: totalOutstandingBalance,
            invoices: rows,
          },
        }
      } catch (err) {
        if (err instanceof BedrockConnectionMissingError) {
          return {
            ok: false,
            status: 'FAILED_PERMANENT',
            error: 'This workspace has no TropiTrack (construction ledger) connection configured.',
          }
        }
        return {
          ok: false,
          status: 'FAILED_RETRYABLE',
          error: err instanceof Error ? err.message : 'Failed to read receivables from TropiTrack.',
        }
      }
    },
  }
}

export const getReceivables: Tool<GetReceivablesInput> = makeGetReceivables()
