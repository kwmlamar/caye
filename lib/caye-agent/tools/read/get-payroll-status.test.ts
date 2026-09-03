import { describe, it, expect } from 'vitest'
import { makeGetPayrollStatus } from './get-payroll-status'
import {
  BedrockConnectionMissingError,
  BedrockNotFoundError,
  type BedrockPayPeriod,
  type BedrockPayrollSummary,
} from '@/lib/domain-adapters/bedrock'
import type { ToolContext } from '../types'

const ctx: ToolContext = {
  workspaceId: 'ws-1',
  callerRole: 'owner',
  requestId: 'req-1',
}

function summary(overrides: Partial<BedrockPayrollSummary> = {}): BedrockPayrollSummary {
  return {
    sourceSystem: 'bedrock',
    authority: 'external_authoritative',
    sourceEntityType: 'payroll_summary',
    sourceEntityId: 'period-1',
    workspaceId: 'ws-1',
    companyId: 'company-1',
    id: 'period-1',
    payPeriodId: 'period-1',
    startDate: '2026-08-24',
    endDate: '2026-08-30',
    status: 'paid',
    entryCount: 12,
    grossPay: 5000,
    netPay: 4400,
    totalPaid: 4400,
    unpaidCount: 0,
    partialCount: 0,
    paidCount: 12,
    ...overrides,
  }
}

function payPeriod(overrides: Partial<BedrockPayPeriod> = {}): BedrockPayPeriod {
  return {
    sourceSystem: 'bedrock',
    authority: 'external_authoritative',
    sourceEntityType: 'pay_period',
    sourceEntityId: 'period-1',
    workspaceId: 'ws-1',
    companyId: 'company-1',
    id: 'period-1',
    startDate: '2026-08-24',
    endDate: '2026-08-30',
    status: 'paid',
    ...overrides,
  }
}

/** No production test needs pay periods listed unless resolving a reference. */
const noPayPeriods = async () => []

describe('getPayrollStatus', () => {
  it('returns the payroll summary shape for a fully-paid period', async () => {
    const tool = makeGetPayrollStatus(() => ({
      getPayrollSummary: async (workspaceId, payPeriodId) => {
        expect(workspaceId).toBe('ws-1')
        expect(payPeriodId).toBe('period-1')
        return summary()
      },
      listPayPeriods: noPayPeriods,
    }))

    const result = await tool.execute({ pay_period_id: 'period-1' }, ctx)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    const data = result.data as any
    expect(data).toMatchObject({
      pay_period_id: 'period-1',
      start_date: '2026-08-24',
      end_date: '2026-08-30',
      entry_count: 12,
      paid_count: 12,
      partial_count: 0,
      unpaid_count: 0,
      gross_pay: 5000,
      net_pay: 4400,
      total_paid: 4400,
      needs_attention: false,
    })
    expect(data.summary).toMatch(/all 12 workers paid in full/i)
  })

  it('surfaces the exception clearly when some workers are unpaid or partial', async () => {
    const tool = makeGetPayrollStatus(() => ({
      getPayrollSummary: async () =>
        summary({ unpaidCount: 2, partialCount: 1, paidCount: 9, totalPaid: 3800, netPay: 4400 }),
      listPayPeriods: noPayPeriods,
    }))

    const result = await tool.execute({ pay_period_id: 'period-1' }, ctx)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    const data = result.data as any
    expect(data.needs_attention).toBe(true)
    expect(data.outstanding).toBe(600)
    expect(data.summary).toMatch(/2 unpaid, 1 partial/i)
  })

  it('never exposes deduction details or NIB numbers — only passes through the adapter-normalized fields', async () => {
    const tool = makeGetPayrollStatus(() => ({
      getPayrollSummary: async () => summary(),
      listPayPeriods: noPayPeriods,
    }))

    const result = await tool.execute({ pay_period_id: 'period-1' }, ctx)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    const json = JSON.stringify(result.data)
    expect(json).not.toMatch(/nib/i)
    expect(json).not.toMatch(/deduction/i)
  })

  it('returns a clean error (not a throw) when the workspace has no TropiTrack connection', async () => {
    const tool = makeGetPayrollStatus(() => ({
      getPayrollSummary: async () => {
        throw new BedrockConnectionMissingError('ws-1')
      },
      listPayPeriods: noPayPeriods,
    }))

    const result = await tool.execute({ pay_period_id: 'period-1' }, ctx)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.status).toBe('FAILED_PERMANENT')
    expect(result.error).toMatch(/no TropiTrack/i)
  })

  it('returns a clean not-found error for an unknown pay period', async () => {
    const tool = makeGetPayrollStatus(() => ({
      getPayrollSummary: async () => {
        throw new BedrockNotFoundError('pay period', 'bogus-id')
      },
      listPayPeriods: noPayPeriods,
    }))

    const result = await tool.execute({ pay_period_id: 'bogus-id' }, ctx)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.status).toBe('NOT_FOUND')
  })

  it('requires pay_period_id or reference', async () => {
    const tool = makeGetPayrollStatus(() => ({
      getPayrollSummary: async () => summary(),
      listPayPeriods: noPayPeriods,
    }))
    const result = await tool.execute({ pay_period_id: '  ' }, ctx)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.status).toBe('FAILED_PERMANENT')
  })

  it('resolves reference "latest" to the most recent pay period without ever being given an id', async () => {
    const tool = makeGetPayrollStatus(() => ({
      listPayPeriods: async (workspaceId, options) => {
        expect(workspaceId).toBe('ws-1')
        expect(options).toMatchObject({ limit: 1 })
        return [payPeriod({ id: 'period-latest', startDate: '2026-08-24', endDate: '2026-08-30' })]
      },
      getPayrollSummary: async (workspaceId, payPeriodId) => {
        expect(payPeriodId).toBe('period-latest')
        return summary({ id: 'period-latest', sourceEntityId: 'period-latest', payPeriodId: 'period-latest' })
      },
    }))

    const result = await tool.execute({ reference: 'latest' }, ctx)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect((result.data as any).pay_period_id).toBe('period-latest')
  })

  it('resolves a plain date reference to the pay period that contains it, without an id', async () => {
    const periods = [
      payPeriod({ id: 'period-later', startDate: '2026-08-31', endDate: '2026-09-06' }),
      payPeriod({ id: 'period-target', startDate: '2026-08-24', endDate: '2026-08-30' }),
      payPeriod({ id: 'period-earlier', startDate: '2026-08-17', endDate: '2026-08-23' }),
    ]
    const tool = makeGetPayrollStatus(() => ({
      listPayPeriods: async () => periods,
      getPayrollSummary: async (workspaceId, payPeriodId) => {
        expect(payPeriodId).toBe('period-target')
        return summary({ id: 'period-target', sourceEntityId: 'period-target', payPeriodId: 'period-target' })
      },
    }))

    const result = await tool.execute({ reference: '2026-08-27' }, ctx)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect((result.data as any).pay_period_id).toBe('period-target')
  })

  it('returns a clean not-found error when no pay period covers the given date reference', async () => {
    const tool = makeGetPayrollStatus(() => ({
      listPayPeriods: async () => [payPeriod({ id: 'period-1', startDate: '2026-08-24', endDate: '2026-08-30' })],
      getPayrollSummary: async () => summary(),
    }))

    const result = await tool.execute({ reference: '2099-01-01' }, ctx)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.status).toBe('NOT_FOUND')
  })

  it('prefers an explicit pay_period_id over reference when both are given', async () => {
    const tool = makeGetPayrollStatus(() => ({
      listPayPeriods: async () => {
        throw new Error('listPayPeriods should not be called when pay_period_id is given')
      },
      getPayrollSummary: async (workspaceId, payPeriodId) => {
        expect(payPeriodId).toBe('period-explicit')
        return summary({ id: 'period-explicit', sourceEntityId: 'period-explicit', payPeriodId: 'period-explicit' })
      },
    }))

    const result = await tool.execute({ pay_period_id: 'period-explicit', reference: 'latest' }, ctx)
    expect(result.ok).toBe(true)
  })
})
