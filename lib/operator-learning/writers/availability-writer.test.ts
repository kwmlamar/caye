import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))

let serviceLookupResult:
  | { ok: true; service: { id: string; name: string } }
  | { ok: false; error: string } = { ok: false, error: 'no lookup requested' }
let upsertCalls: { table: string; row: Record<string, unknown>; onConflict: string }[] = []
let upsertError: { message: string } | null = null

vi.mock('@/lib/caye-agent/tools/_catalog-helpers', () => ({
  resolveServiceByName: async () => serviceLookupResult,
}))

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({
    from(table: string) {
      return {
        upsert: (row: Record<string, unknown>, opts: { onConflict: string }) => ({
          select: () => ({
            single: async () => {
              upsertCalls.push({ table, row, onConflict: opts.onConflict })
              if (upsertError) return { data: null, error: upsertError }
              return { data: { id: `${table}-new` }, error: null }
            },
          }),
        }),
      }
    },
  }),
}))

const { writeAvailabilityRecurring, writeAvailabilityDate } = await import('./availability-writer')
const { validateClassification } = await import('../schema')

function recurringClassification(fields: Record<string, unknown> = {}) {
  const res = validateClassification({
    learnable: true,
    explicitness: 'explicit_statement',
    scope: { kind: 'standing', target: 'service', serviceName: 'Full Bimini Experience', dateISO: null },
    risk: 'low',
    destination: 'availability_recurring',
    canonicalKey: 'full-bimini-sunday-rule',
    confidence: 0.9,
    rationale: 'owner stated a weekday rule',
    availabilityRecurring: {
      serviceName: 'Full Bimini Experience',
      weekday: 0,
      effect: 'unavailable',
      minParty: 6,
      note: 'Full Bimini only runs Sundays for 6+.',
      ...fields,
    },
  })
  if (!res.ok) throw new Error(`bad fixture: ${res.reason}`)
  return res.value
}

function dateClassification(fields: Record<string, unknown> = {}) {
  const res = validateClassification({
    learnable: true,
    explicitness: 'explicit_correction',
    scope: { kind: 'date_scoped', target: 'specific_date', dateISO: '2026-09-05' },
    risk: 'low',
    destination: 'availability_date',
    canonicalKey: 'full-bimini-2026-09-05',
    confidence: 0.9,
    rationale: 'owner stated a one-date restriction',
    availabilityDate: {
      serviceName: 'Full Bimini Experience',
      dateISO: '2026-09-05',
      effect: 'variant_only',
      minParty: null,
      restrictedVariant: 'private',
      note: null,
      ...fields,
    },
  })
  if (!res.ok) throw new Error(`bad fixture: ${res.reason}`)
  return res.value
}

beforeEach(() => {
  serviceLookupResult = { ok: false, error: 'no lookup requested' }
  upsertCalls = []
  upsertError = null
})

describe('writeAvailabilityRecurring', () => {
  it('upserts on (workspace, service, weekday, effect) so a re-stated rule updates in place, never stacks', async () => {
    serviceLookupResult = { ok: true, service: { id: 'svc-1', name: 'Full Bimini Experience' } }
    const outcome = await writeAvailabilityRecurring({ workspaceId: 'ws-1', callerRole: 'owner', classification: recurringClassification() })
    expect(outcome.decision).toBe('written')
    expect(upsertCalls[0]).toMatchObject({
      table: 'service_availability_rules',
      onConflict: 'workspace_id,service_id,weekday,effect',
    })
    expect(upsertCalls[0].row).toMatchObject({ weekday: 0, effect: 'unavailable', min_party: 6 })
  })

  it('holds as candidate when the service cannot be resolved', async () => {
    serviceLookupResult = { ok: false, error: 'no match' }
    const outcome = await writeAvailabilityRecurring({ workspaceId: 'ws-1', callerRole: 'owner', classification: recurringClassification() })
    expect(outcome.decision).toBe('candidate')
    expect(upsertCalls).toHaveLength(0)
  })
})

describe('writeAvailabilityDate', () => {
  it('upserts a variant_only override for one date (Bimini: private-only Sept 5) without touching any other date', async () => {
    serviceLookupResult = { ok: true, service: { id: 'svc-1', name: 'Full Bimini Experience' } }
    const outcome = await writeAvailabilityDate({ workspaceId: 'ws-1', callerRole: 'owner', classification: dateClassification() })
    expect(outcome.decision).toBe('written')
    expect(upsertCalls[0]).toMatchObject({
      table: 'service_date_overrides',
      onConflict: 'workspace_id,service_id,date_iso,effect',
    })
    expect(upsertCalls[0].row).toMatchObject({ date_iso: '2026-09-05', effect: 'variant_only', restricted_variant: 'private' })
  })

  it('holds as candidate when the service cannot be resolved, never guessing a date-scoped write', async () => {
    serviceLookupResult = { ok: false, error: 'ambiguous' }
    const outcome = await writeAvailabilityDate({ workspaceId: 'ws-1', callerRole: 'owner', classification: dateClassification() })
    expect(outcome.decision).toBe('candidate')
    expect(upsertCalls).toHaveLength(0)
  })

  it('surfaces a DB error as decision=error', async () => {
    serviceLookupResult = { ok: true, service: { id: 'svc-1', name: 'Full Bimini Experience' } }
    upsertError = { message: 'connection reset' }
    const outcome = await writeAvailabilityDate({ workspaceId: 'ws-1', callerRole: 'owner', classification: dateClassification() })
    expect(outcome.decision).toBe('error')
  })
})
