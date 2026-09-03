import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { BedrockWriteProvider, type BedrockTimeEntryInsert } from './write-provider'
import type { BedrockConnection } from './types'

const connection: BedrockConnection = {
  workspaceId: 'ws-1',
  companyId: 'company-1',
  supabaseUrl: 'https://bedrock.invalid',
  serviceRoleKey: 'super-secret-key',
}

// Realistic ODS crew-day fixtures: 60-minute break, 07:00-16:00 shift,
// 8 regular hours, no overtime -- the measured defaults from the brief.
function crewDayRow(overrides: Partial<BedrockTimeEntryInsert> = {}): BedrockTimeEntryInsert {
  return {
    worker_id: 'worker-omar',
    project_id: 'project-blue-sky-great-room',
    date: '2026-09-02',
    start_time: '07:00:00',
    end_time: '16:00:00',
    break_duration_minutes: 60,
    regular_hours: 8,
    overtime_hours: 0,
    notes: 'Blue Sky Villa — Great Room Flooring',
    created_by: 'caye-agent',
    company_id: 'company-1',
    ...overrides,
  }
}

type TimeEntryOutcome = { data?: { id: string }; error?: { message: string } | null }
type AuditLogOutcome = { error?: { message: string } | null }

/**
 * Fake Supabase client -- no module mocking, no network, per house
 * convention (lib/domain-adapters/bedrock/adapter.test.ts). Records every
 * row handed to `time_entries` and `audit_logs` inserts and lets each test
 * script per-row outcomes.
 */
function fakeClient(options: {
  timeEntryOutcomes?: (row: Record<string, unknown>, index: number) => TimeEntryOutcome
  auditLogOutcome?: (row: Record<string, unknown>) => AuditLogOutcome
} = {}) {
  const timeEntryCalls: Record<string, unknown>[] = []
  const auditLogCalls: Record<string, unknown>[] = []
  let timeEntrySeq = 0

  const client = {
    from(table: string) {
      if (table === 'time_entries') {
        return {
          insert(row: Record<string, unknown>) {
            timeEntryCalls.push(row)
            const index = timeEntrySeq++
            return {
              select() {
                return {
                  async single(): Promise<TimeEntryOutcome> {
                    if (options.timeEntryOutcomes) {
                      const outcome = options.timeEntryOutcomes(row, index)
                      return { data: outcome.data, error: outcome.error ?? null }
                    }
                    return { data: { id: `time-entry-${index}` }, error: null }
                  },
                }
              },
            }
          },
        }
      }
      if (table === 'audit_logs') {
        return {
          insert(row: Record<string, unknown>) {
            auditLogCalls.push(row)
            const outcome = options.auditLogOutcome ? options.auditLogOutcome(row) : { error: null }
            return Promise.resolve({ error: outcome.error ?? null })
          },
        }
      }
      throw new Error(`fakeClient: unexpected table "${table}"`)
    },
  } as unknown as SupabaseClient

  return { client, timeEntryCalls, auditLogCalls }
}

function makeProvider(fake: ReturnType<typeof fakeClient>) {
  return new BedrockWriteProvider(connection, () => fake.client)
}

describe('BedrockWriteProvider.insertTimeEntries', () => {
  it('forces the resolved company id onto every row, even when the caller passed a different one', async () => {
    const fake = fakeClient()
    const provider = makeProvider(fake)

    const result = await provider.insertTimeEntries('company-1', [
      crewDayRow({ worker_id: 'worker-omar', company_id: 'foreign-company-999' }),
      crewDayRow({ worker_id: 'worker-dwight', company_id: 'another-foreign-company' }),
    ])

    expect(result.insertedCount).toBe(2)
    expect(fake.timeEntryCalls).toHaveLength(2)
    for (const call of fake.timeEntryCalls) {
      expect(call.company_id).toBe('company-1')
    }
  })

  it('writes exactly one audit_logs row with the constrained source/scope/tier on success', async () => {
    const fake = fakeClient()
    const provider = makeProvider(fake)

    const result = await provider.insertTimeEntries('company-1', [crewDayRow()])

    expect(result.ok).toBe(true)
    expect(fake.auditLogCalls).toHaveLength(1)
    expect(fake.auditLogCalls[0]).toMatchObject({
      company_id: 'company-1',
      source: 'api',
      scope: 'write',
      tier: 'confirm',
      status: 'ok',
      target_table: 'time_entries',
    })
    expect(result.auditLogWritten).toBe(true)
    expect(result.auditLogError).toBeNull()
  })

  it('still writes an audit row when the insert fails, with status error and a message', async () => {
    const fake = fakeClient({
      timeEntryOutcomes: () => ({ error: { message: 'duplicate key value violates unique constraint' } }),
    })
    const provider = makeProvider(fake)

    const result = await provider.insertTimeEntries('company-1', [crewDayRow()])

    expect(result.ok).toBe(false)
    expect(result.insertedCount).toBe(0)
    expect(result.failedRows).toHaveLength(1)
    expect(fake.auditLogCalls).toHaveLength(1)
    expect(fake.auditLogCalls[0]).toMatchObject({ status: 'error' })
    expect(fake.auditLogCalls[0].error_message).toContain('duplicate key value')
  })

  it('reports partial failure with precise counts and names the failed rows, never as success', async () => {
    const fake = fakeClient({
      timeEntryOutcomes: (_row, index) =>
        index === 1 ? { error: { message: 'worker_id violates foreign key constraint' } } : { data: { id: `time-entry-${index}` } },
    })
    const provider = makeProvider(fake)

    const result = await provider.insertTimeEntries('company-1', [
      crewDayRow({ worker_id: 'worker-omar' }),
      crewDayRow({ worker_id: 'worker-unknown' }),
      crewDayRow({ worker_id: 'worker-dwight' }),
    ])

    expect(result.ok).toBe(false)
    expect(result.attemptedCount).toBe(3)
    expect(result.insertedCount).toBe(2)
    expect(result.failedRows).toHaveLength(1)
    expect(result.failedRows[0]).toMatchObject({ index: 1, error: expect.stringContaining('foreign key') })
    expect(result.failedRows[0].row.worker_id).toBe('worker-unknown')

    expect(fake.auditLogCalls[0]).toMatchObject({ status: 'error' })
    const auditResult = fake.auditLogCalls[0].result as { insertedCount: number; failedCount: number }
    expect(auditResult.insertedCount).toBe(2)
    expect(auditResult.failedCount).toBe(1)
  })

  it('surfaces an audit-log write failure on the result instead of swallowing it', async () => {
    const fake = fakeClient({
      auditLogOutcome: () => ({ error: { message: 'audit_logs insert timed out' } }),
    })
    const provider = makeProvider(fake)

    const result = await provider.insertTimeEntries('company-1', [crewDayRow()])

    // The time entry itself landed...
    expect(result.insertedCount).toBe(1)
    // ...but the overall result must not read as a clean success, because
    // the write is now invisible to ODS's own audit trail.
    expect(result.ok).toBe(false)
    expect(result.auditLogWritten).toBe(false)
    expect(result.auditLogError).toBe('audit_logs insert timed out')
  })

  it('treats an empty rows array as a no-op that writes no audit row', async () => {
    const fake = fakeClient()
    const provider = makeProvider(fake)

    const result = await provider.insertTimeEntries('company-1', [])

    expect(result).toEqual({
      ok: true,
      attemptedCount: 0,
      insertedCount: 0,
      insertedIds: [],
      failedRows: [],
      auditLogWritten: false,
      auditLogError: null,
    })
    expect(fake.timeEntryCalls).toHaveLength(0)
    expect(fake.auditLogCalls).toHaveLength(0)
  })

  it('cannot set approved_by or approved_at through this path', async () => {
    const fake = fakeClient()
    const provider = makeProvider(fake)

    const rowWithApproval = {
      ...crewDayRow(),
      approved_by: 'sneaky-approver',
      approved_at: '2026-09-02T00:00:00Z',
    } as unknown as BedrockTimeEntryInsert

    await provider.insertTimeEntries('company-1', [rowWithApproval])

    expect(fake.timeEntryCalls).toHaveLength(1)
    expect(fake.timeEntryCalls[0]).not.toHaveProperty('approved_by')
    expect(fake.timeEntryCalls[0]).not.toHaveProperty('approved_at')
  })
})
