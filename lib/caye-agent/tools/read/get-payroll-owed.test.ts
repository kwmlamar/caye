import { describe, it, expect } from 'vitest'
import { makeGetPayrollOwed } from './get-payroll-owed'
import { BedrockConnectionMissingError, type BedrockPayrollOwed } from '@/lib/domain-adapters/bedrock'
import type { ToolContext } from '../types'

const ctx: ToolContext = {
  workspaceId: 'ws-1',
  callerRole: 'owner',
  requestId: 'req-1',
}

/** Fixed clock so the default from/to window never depends on the real wall-clock date. */
const NOW = () => new Date('2026-08-21T12:00:00Z')

function payrollOwed(overrides: Partial<BedrockPayrollOwed> = {}): BedrockPayrollOwed {
  return {
    sourceSystem: 'bedrock',
    authority: 'external_authoritative',
    sourceEntityType: 'payroll_owed',
    sourceEntityId: 'company-1',
    workspaceId: 'ws-1',
    companyId: 'company-1',
    id: 'company-1',
    totalOwed: 15313.45,
    entryCount: 4,
    periodCount: 2,
    rangeStart: '2026-02-21',
    rangeEnd: '2026-08-21',
    workers: [
      { workerId: 'worker-cyrike', workerName: 'Cyrike Tiler', owed: 10298.45 },
      { workerId: 'worker-earnest', workerName: 'Earnest Phillipe', owed: 5015.0 },
    ],
    ...overrides,
  }
}

describe('getPayrollOwed', () => {
  it('defaults to a 6-month window ending today when no range is given', async () => {
    const tool = makeGetPayrollOwed(() => ({
      getPayrollOwed: async (workspaceId, options) => {
        expect(workspaceId).toBe('ws-1')
        expect(options).toEqual({ from: '2026-02-21', to: '2026-08-21' })
        return payrollOwed()
      },
    }), NOW)

    const result = await tool.execute({}, ctx)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    const data = result.data as any
    expect(data.requested_from).toBe('2026-02-21')
    expect(data.requested_to).toBe('2026-08-21')
    expect(data.total_owed).toBe(15313.45)
  })

  it('honours an explicit months_back', async () => {
    const tool = makeGetPayrollOwed(() => ({
      getPayrollOwed: async (workspaceId, options) => {
        expect(options).toEqual({ from: '2026-06-21', to: '2026-08-21' })
        return payrollOwed()
      },
    }), NOW)

    const result = await tool.execute({ months_back: 2 }, ctx)
    expect(result.ok).toBe(true)
  })

  it('honours explicit from/to over months_back', async () => {
    const tool = makeGetPayrollOwed(() => ({
      getPayrollOwed: async (workspaceId, options) => {
        expect(options).toEqual({ from: '2026-01-01', to: '2026-03-31' })
        return payrollOwed({ rangeStart: '2026-01-05', rangeEnd: '2026-03-28' })
      },
    }), NOW)

    const result = await tool.execute({ from: '2026-01-01', to: '2026-03-31', months_back: 12 }, ctx)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    const data = result.data as any
    expect(data.requested_from).toBe('2026-01-01')
    expect(data.requested_to).toBe('2026-03-31')
  })

  it('surfaces the total owed, period/entry counts, actual range, and per-worker breakdown -- never the raw net_pay sum', async () => {
    const tool = makeGetPayrollOwed(() => ({
      getPayrollOwed: async () => payrollOwed(),
    }), NOW)

    const result = await tool.execute({}, ctx)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    const data = result.data as any

    expect(data.total_owed).toBe(15313.45)
    expect(data.total_owed).not.toBe(24298.45) // the naive net_pay sum from the real incident
    expect(data.entry_count).toBe(4)
    expect(data.period_count).toBe(2)
    expect(data.range_start).toBe('2026-02-21')
    expect(data.range_end).toBe('2026-08-21')
    expect(data.workers).toEqual([
      { worker_id: 'worker-cyrike', worker_name: 'Cyrike Tiler', owed: 10298.45 },
      { worker_id: 'worker-earnest', worker_name: 'Earnest Phillipe', owed: 5015.0 },
    ])
  })

  it('states plainly that this is a ledger figure, not a bank balance', async () => {
    const tool = makeGetPayrollOwed(() => ({
      getPayrollOwed: async () => payrollOwed(),
    }), NOW)

    const result = await tool.execute({}, ctx)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect((result.data as any).note).toMatch(/not a bank balance/i)
  })

  it('never exposes deduction details or NIB numbers', async () => {
    const tool = makeGetPayrollOwed(() => ({
      getPayrollOwed: async () => payrollOwed(),
    }), NOW)

    const result = await tool.execute({}, ctx)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    const json = JSON.stringify(result.data)
    expect(json).not.toMatch(/nib/i)
    expect(json).not.toMatch(/deduction/i)
  })

  it('returns a clean error (not a throw) when the workspace has no TropiTrack connection', async () => {
    const tool = makeGetPayrollOwed(() => ({
      getPayrollOwed: async () => {
        throw new BedrockConnectionMissingError('ws-1')
      },
    }), NOW)

    const result = await tool.execute({}, ctx)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.status).toBe('FAILED_PERMANENT')
    expect(result.error).toMatch(/no TropiTrack/i)
  })

  it('returns a clean retryable error for an unexpected failure', async () => {
    const tool = makeGetPayrollOwed(() => ({
      getPayrollOwed: async () => {
        throw new Error('connection reset')
      },
    }), NOW)

    const result = await tool.execute({}, ctx)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.status).toBe('FAILED_RETRYABLE')
  })
})
