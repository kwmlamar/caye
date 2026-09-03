import 'server-only'
import {
  createBedrockAdapter,
  BedrockConnectionMissingError,
  BedrockNotFoundError,
  type BedrockAdapter,
} from '@/lib/domain-adapters/bedrock'
import type { Tool } from '../types'

export interface GetPayrollStatusInput {
  /** Exact TropiTrack pay period id, when already known. */
  pay_period_id?: string
  /**
   * A natural reference in place of an id: the literal string "latest", or
   * a YYYY-MM-DD date that falls inside the wanted pay period. Resolved via
   * listPayPeriods -- never surfaced to a human as a requirement.
   */
  reference?: string
}

/** The subset of BedrockAdapter this tool calls — narrowed for test injection. */
type PayrollAdapter = Pick<BedrockAdapter, 'getPayrollSummary' | 'listPayPeriods'>

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * Resolves a human-shaped reference ("latest", or a date that falls inside
 * a period) to a real pay_period_id via listPayPeriods.
 *
 * This function exists so this tool never has to ask a person for a
 * database identifier. The bug this fixes was real: an owner asked "how
 * much do we owe everyone", got a good clarifying question back, and then
 * Caye asked her for pay-period IDs to finish the answer -- handing its own
 * internal-lookup limitation to a human instead of resolving it itself. The
 * principle this encodes: ask about intent (which period, which range),
 * never about identifiers (only the system can know an id).
 */
async function resolvePayPeriodId(
  adapter: PayrollAdapter,
  workspaceId: string,
  reference: string
): Promise<{ id: string } | { error: string }> {
  const ref = reference.trim()

  if (ref.toLowerCase() === 'latest') {
    const periods = await adapter.listPayPeriods(workspaceId, { limit: 1 })
    const latest = periods[0]
    if (!latest) return { error: 'No TropiTrack pay periods exist for this workspace yet.' }
    return { id: latest.id }
  }

  // Otherwise treat the reference as a date and find the period it falls inside.
  // Pay periods are few enough at ODS's scale (dozens) that a bounded scan and
  // an in-memory containment check is cheaper and more correct than trying to
  // express "start_date <= ref <= end_date" as a single provider-level filter.
  const periods = await adapter.listPayPeriods(workspaceId, { limit: 200 })
  const match = periods.find((period) => {
    const start = period.startDate
    const end = period.endDate
    return start !== null && end !== null && start <= ref && ref <= end
  })
  if (!match) return { error: `No TropiTrack pay period covers ${ref}.` }
  return { id: match.id }
}

/**
 * Factory seam: production callers get the real, kernel-bound Bedrock
 * adapter; tests pass a fake implementing only getPayrollSummary /
 * listPayPeriods (see get-payroll-status.test.ts).
 */
export function makeGetPayrollStatus(
  getAdapter: () => PayrollAdapter = createBedrockAdapter
): Tool<GetPayrollStatusInput> {
  return {
    name: 'get_payroll_status',
    description:
      'Payroll status for one TropiTrack pay period — the weekly exception check, not the roster. ' +
      "Surfaces paid/partial/unpaid counts and a plain needs_attention flag so a partially-paid period stands out immediately rather than requiring a manual scan of every worker. " +
      'Returns gross/net/total-paid dollar totals and the outstanding (net - paid) amount, but never deduction line items or NIB numbers — the TropiTrack read adapter does not normalize those fields at all, so there is nothing to filter beyond passing through exactly what the adapter returns. ' +
      'Accepts either an exact pay_period_id, or a natural reference in the `reference` field — the literal word "latest" for the most recent period, or any date that falls inside the wanted period (YYYY-MM-DD). ' +
      'This tool never needs a human to supply a pay-period id: if only a date, "this week", or "latest" is known, pass that as `reference` and the id is resolved internally. If the question is genuinely ambiguous (e.g. which range of periods, or paid-vs-unpaid intent), ask the human about that intent — never ask them for an id, which is a database detail no human can be expected to know.',
    risk: 'read',
    roles: ['owner', 'founder'],
    modes: ['back-office'],
    inputSchema: {
      type: 'object',
      properties: {
        pay_period_id: {
          type: 'string',
          description: 'The exact TropiTrack pay period id to check, when already known.',
        },
        reference: {
          type: 'string',
          description:
            'A natural reference to resolve to a pay period instead of an id: "latest" for the most recent period, or a YYYY-MM-DD date that falls inside the wanted period.',
        },
      },
    },

    async execute(args, ctx) {
      const adapter = getAdapter()
      const explicitId = args.pay_period_id?.trim()
      const reference = args.reference?.trim()

      let payPeriodId: string
      if (explicitId) {
        payPeriodId = explicitId
      } else if (reference) {
        const resolved = await resolvePayPeriodId(adapter, ctx.workspaceId, reference)
        if ('error' in resolved) {
          return { ok: false, status: 'NOT_FOUND', error: resolved.error }
        }
        payPeriodId = resolved.id
      } else {
        return {
          ok: false,
          status: 'FAILED_PERMANENT',
          error: 'Provide pay_period_id, or a reference ("latest" or a date inside the wanted period).',
        }
      }

      try {
        const summary = await adapter.getPayrollSummary(ctx.workspaceId, payPeriodId)
        const needsAttention = summary.unpaidCount > 0 || summary.partialCount > 0
        const outstanding = round2(summary.netPay - summary.totalPaid)

        return {
          ok: true,
          data: {
            pay_period_id: summary.payPeriodId,
            start_date: summary.startDate,
            end_date: summary.endDate,
            status: summary.status,
            entry_count: summary.entryCount,
            paid_count: summary.paidCount,
            partial_count: summary.partialCount,
            unpaid_count: summary.unpaidCount,
            gross_pay: summary.grossPay,
            net_pay: summary.netPay,
            total_paid: summary.totalPaid,
            outstanding,
            needs_attention: needsAttention,
            summary: needsAttention
              ? `${summary.unpaidCount} unpaid, ${summary.partialCount} partial of ${summary.entryCount} workers this period — needs attention.`
              : `All ${summary.entryCount} workers paid in full for this period.`,
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
        if (err instanceof BedrockNotFoundError) {
          return {
            ok: false,
            status: 'NOT_FOUND',
            error: `No TropiTrack pay period found for id "${payPeriodId}".`,
          }
        }
        return {
          ok: false,
          status: 'FAILED_RETRYABLE',
          error: err instanceof Error ? err.message : 'Failed to read payroll status from TropiTrack.',
        }
      }
    },
  }
}

export const getPayrollStatus: Tool<GetPayrollStatusInput> = makeGetPayrollStatus()
