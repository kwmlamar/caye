import 'server-only'
import {
  createBedrockAdapter,
  BedrockConnectionMissingError,
  type BedrockAdapter,
} from '@/lib/domain-adapters/bedrock'
import type { Tool } from '../types'

export interface GetPayrollOwedInput {
  /** Start of the window, inclusive, as YYYY-MM-DD. Optional -- defaults from months_back. */
  from?: string
  /** End of the window, inclusive, as YYYY-MM-DD. Defaults to today. */
  to?: string
  /** How many months back from today to look when `from`/`to` are not given. Defaults to 6. */
  months_back?: number
}

/**
 * The subset of BedrockAdapter this tool actually calls -- narrowed so tests
 * can inject a fake without shaping every other adapter method.
 */
type PayrollOwedAdapter = Pick<BedrockAdapter, 'getPayrollOwed'>

/**
 * Formats a Date as a UTC `YYYY-MM-DD`, matching the plain calendar dates
 * pay_periods.end_date carries.
 */
function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/** `n` whole months before `date`, computed in UTC so the injected clock is the only source of "now". */
function monthsBefore(date: Date, months: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - months, date.getUTCDate()))
}

/**
 * Factory seam: production callers get the real, kernel-bound Bedrock
 * adapter; tests pass a fake implementing only getPayrollOwed (see
 * get-payroll-owed.test.ts). `now` is a second seam for the same reason --
 * the default window must be computed from a fixed, injected clock in
 * tests, never from the real wall-clock date.
 */
export function makeGetPayrollOwed(
  getAdapter: () => PayrollOwedAdapter = createBedrockAdapter,
  now: () => Date = () => new Date()
): Tool<GetPayrollOwedInput> {
  return {
    name: 'get_payroll_owed',
    description:
      'How much ODS still owes workers across a date range of TropiTrack pay periods -- the answer to "how much do we owe everyone", never a tool that needs a pay-period id. ' +
      "Owed is computed as net_pay minus total_paid per entry, never a raw sum of net pay -- partial payroll payments are routine at ODS (payment_status is unpaid | partial | paid), so treating every unpaid entry as fully unpaid overstates the real figure. " +
      'Accepts a natural range: explicit from/to dates (YYYY-MM-DD), or months_back (default 6) counted from today. Never accepts or needs a pay_period_id -- if the ambiguity is "unpaid balance vs. total paid", ask the human that question, not for an identifier only the system can know. ' +
      'Returns the total owed, how many entries and pay periods that total spans, the actual date range those periods cover, and a per-worker breakdown of what each person is owed. ' +
      'This is what the payroll ledger records as unpaid -- not a bank balance, and not a promise about when money will move. ' +
      'Never returns deduction line items or NIB numbers.',
    risk: 'read',
    roles: ['owner', 'founder'],
    modes: ['back-office'],
    inputSchema: {
      type: 'object',
      properties: {
        from: {
          type: 'string',
          description: 'Start of the window, inclusive, as YYYY-MM-DD. Optional -- defaults using months_back.',
        },
        to: {
          type: 'string',
          description: 'End of the window, inclusive, as YYYY-MM-DD. Defaults to today.',
        },
        months_back: {
          type: 'number',
          description: 'How many months back from today to look when from/to are not given. Defaults to 6.',
        },
      },
    },

    async execute(args, ctx) {
      const asOf = now()
      const to = args.to?.trim() || isoDate(asOf)
      const from = args.from?.trim() || isoDate(monthsBefore(asOf, args.months_back ?? 6))

      const adapter = getAdapter()
      try {
        const owed = await adapter.getPayrollOwed(ctx.workspaceId, { from, to })

        return {
          ok: true,
          data: {
            requested_from: from,
            requested_to: to,
            range_start: owed.rangeStart,
            range_end: owed.rangeEnd,
            period_count: owed.periodCount,
            entry_count: owed.entryCount,
            total_owed: owed.totalOwed,
            workers: owed.workers.map((w) => ({
              worker_id: w.workerId,
              worker_name: w.workerName,
              owed: w.owed,
            })),
            note:
              'This is what the TropiTrack payroll ledger records as unpaid (net pay already earned minus what has actually been paid out) for entries in this window -- it is not a bank balance and is not a promise about when the remainder will be paid.',
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
          error: err instanceof Error ? err.message : 'Failed to read payroll owed from TropiTrack.',
        }
      }
    },
  }
}

export const getPayrollOwed: Tool<GetPayrollOwedInput> = makeGetPayrollOwed()
