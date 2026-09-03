import { describe, it, expect } from 'vitest'
import { makeGetPayrollStatus } from './get-payroll-status'
import {
  BedrockConnectionMissingError,
  BedrockNotFoundError,
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

describe('getPayrollStatus', () => {
  it('returns the payroll summary shape for a fully-paid period', async () => {
    const tool = makeGetPayrollStatus(() => ({
      getPayrollSummary: async (workspaceId, payPeriodId) => {
        expect(workspaceId).toBe('ws-1')
        expect(payPeriodId).toBe('period-1')
        return summary()
      },
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
    }))

    const result = await tool.execute({ pay_period_id: 'bogus-id' }, ctx)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.status).toBe('NOT_FOUND')
  })

  it('requires pay_period_id', async () => {
    const tool = makeGetPayrollStatus(() => ({
      getPayrollSummary: async () => summary(),
    }))
    const result = await tool.execute({ pay_period_id: '  ' }, ctx)
    expect(result.ok).toBe(false)
  })
})
