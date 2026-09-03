import 'server-only'
import {
  createBedrockAdapter,
  BedrockConnectionMissingError,
  BedrockNotFoundError,
  type BedrockAdapter,
} from '@/lib/domain-adapters/bedrock'
import type { Tool } from '../types'

export interface GetPayrollStatusInput {
  /** TropiTrack pay period id. */
  pay_period_id: string
}

/** The subset of BedrockAdapter this tool calls — narrowed for test injection. */
type PayrollAdapter = Pick<BedrockAdapter, 'getPayrollSummary'>

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * Factory seam: production callers get the real, kernel-bound Bedrock
 * adapter; tests pass a fake implementing only getPayrollSummary (see
 * get-payroll-status.test.ts).
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
      'Requires an exact pay_period_id (resolve it separately if only a date or "this week" was given).',
    risk: 'read',
    roles: ['owner', 'founder'],
    modes: ['back-office'],
    inputSchema: {
      type: 'object',
      properties: {
        pay_period_id: {
          type: 'string',
          description: 'The TropiTrack pay period id to check.',
        },
      },
      required: ['pay_period_id'],
    },

    async execute(args, ctx) {
      const payPeriodId = args.pay_period_id?.trim()
      if (!payPeriodId) {
        return { ok: false, status: 'FAILED_PERMANENT', error: 'Provide pay_period_id.' }
      }

      const adapter = getAdapter()
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
