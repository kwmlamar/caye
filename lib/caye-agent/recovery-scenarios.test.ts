import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Tool, ToolContext, ToolResult } from './tools/types'

/**
 * The failure scenarios from the 2026-08-11 refactor brief, as executable
 * checks. The one that matters most is the last block: the exact exchange
 * where Caye told Mrs. Max to keep her own notes.
 */

vi.mock('server-only', () => ({}))

// ── fakes ───────────────────────────────────────────────────────────────────

interface BookingRow {
  id: string
  user_id: string
  customer_name: string
  booking_date: string
  booking_time: string
  number_of_people: number
  duration_minutes: number | null
  notes: string | null
  zoho_event_id: string | null
  calendar_sync_status?: string | null
  calendar_sync_error?: string | null
  service: { name: string; duration_minutes: number }[] | null
}

const state = {
  booking: null as BookingRow | null,
  syncCalendar: true as boolean,
  hasAccount: true as boolean,
  queued: [] as Record<string, unknown>[],
  /** Emulates the unique index on idempotency_key. */
  queuedKeys: new Set<string>(),
}

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({
    from(table: string) {
      if (table === 'bookings') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({ data: state.booking, error: state.booking ? null : { message: 'no row' } }),
              maybeSingle: async () => ({ data: state.booking, error: null }),
            }),
          }),
          update: (patch: Record<string, unknown>) => ({
            eq: async () => {
              if (state.booking) Object.assign(state.booking, patch)
              return { error: null }
            },
          }),
        }
      }
      if (table === 'connected_accounts') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: state.hasAccount ? { sync_calendar: state.syncCalendar } : null,
                    error: null,
                  }),
                }),
              }),
            }),
          }),
        }
      }
      if (table === 'caye_pending_operations') {
        return {
          insert: async (row: Record<string, unknown>) => {
            const key = row.idempotency_key as string
            if (state.queuedKeys.has(key)) return { error: { code: '23505', message: 'duplicate' } }
            state.queuedKeys.add(key)
            state.queued.push(row)
            return { error: null }
          },
          update: () => ({
            eq: () => ({ like: async () => ({ error: null }) }),
          }),
        }
      }
      // caye_effect_verifications (verifyAndPersistEffect, called from
      // syncBookingToCalendar's real effect-verification wiring) only
      // destructures `{ error }` off a bare `await ...upsert(...)`, with no
      // further chaining — this fake predates that call and its default
      // branch only ever implemented `insert`, so `.upsert` was missing
      // entirely (TypeError, not a silent pass) until added here.
      return {
        insert: async () => ({ error: null }),
        upsert: async () => ({ error: null }),
      }
    },
  }),
}))

const zoho = {
  create: vi.fn(),
  update: vi.fn(),
  del: vi.fn(),
  // Real read-back path (calendar-effect-verification.ts's verifyCalendarUpsert
  // calls listZohoCalendarEvents to observe what Zoho actually has before
  // trusting a create/update as VERIFIED). This test file predates that
  // effect-verification wiring and never mocked list at all — undefined
  // when destructured from the module mock below, so every observation
  // attempt threw and verification could never report VERIFIED. Modeled
  // here as a read-back of the same in-memory booking state.upsert/update
  // already mutated, at call time.
  list: vi.fn(async (..._args: unknown[]) => {
    const b = state.booking
    if (!b?.zoho_event_id) return []
    return [
      {
        uid: b.zoho_event_id,
        startDate: b.booking_date,
        startTime: b.booking_time,
        durationMinutes: b.duration_minutes ?? b.service?.[0]?.duration_minutes ?? 120,
      },
    ]
  }),
}

vi.mock('../zoho-calendar', () => ({
  createZohoCalendarEvent: (...a: unknown[]) => zoho.create(...a),
  updateZohoCalendarEvent: (...a: unknown[]) => zoho.update(...a),
  deleteZohoCalendarEvent: (...a: unknown[]) => zoho.del(...a),
  listZohoCalendarEvents: (...a: unknown[]) => zoho.list(...a),
}))

const { syncBookingToCalendar, calendarIdempotencyKey } = await import('../calendar-sync')
const { runToolWithRecovery, guidanceFor } = await import('./orchestrator')
const { stripForModel } = await import('./tools/result')

const WORKSPACE = '00000000-0000-0000-0000-0000000000aa'

function seedBooking(): BookingRow {
  return {
    id: 'bk-1',
    user_id: WORKSPACE,
    customer_name: 'Valencia Wills',
    booking_date: '2026-08-20',
    booking_time: '10:00:00',
    number_of_people: 2,
    duration_minutes: 120,
    notes: 'Pickup at Resorts World Casino tram stop',
    zoho_event_id: null,
    service: [{ name: 'North Bimini Heritage Tour', duration_minutes: 120 }],
  }
}

beforeEach(() => {
  state.booking = seedBooking()
  state.syncCalendar = true
  state.hasAccount = true
  state.queued = []
  state.queuedKeys.clear()
  zoho.create.mockReset()
  zoho.update.mockReset()
  zoho.del.mockReset()
})

// ── Zoho Calendar failure ───────────────────────────────────────────────────

describe('scenario: Zoho Calendar is down when a booking is created', () => {
  it('keeps the booking, queues the mirror, and reports it as deferred', async () => {
    zoho.create.mockRejectedValue(new Error('Zoho Calendar create failed (503): upstream'))

    const result = await syncBookingToCalendar(WORKSPACE, 'bk-1', 'upsert')

    expect(result).toMatchObject({ synced: false, deferred: true })
    // The booking is untouched and real. This is the whole point of
    // local-first: Zoho being down is not the booking failing.
    expect(state.booking!.id).toBe('bk-1')
    expect(state.booking!.calendar_sync_status).toBe('pending')
    expect(state.queued).toHaveLength(1)
    expect(state.queued[0]).toMatchObject({
      operation: 'zoho_calendar_upsert',
      idempotency_key: calendarIdempotencyKey('bk-1', 'upsert'),
    })
  })

  it('does not queue a second copy when the same sync fails twice', async () => {
    // Duplicate calendar events are the exact hazard retries introduce.
    zoho.create.mockRejectedValue(new Error('Zoho Calendar create failed (503): upstream'))

    await syncBookingToCalendar(WORKSPACE, 'bk-1', 'upsert')
    await syncBookingToCalendar(WORKSPACE, 'bk-1', 'upsert')

    expect(state.queued).toHaveLength(1)
  })

  it('does not queue a permanent failure, and records why', async () => {
    // A 400 will still be a 400 in eight hours. Queueing it just burns the
    // worker's budget and delays telling a human.
    zoho.create.mockRejectedValue(new Error('Zoho Calendar create failed (400): malformed'))

    const result = await syncBookingToCalendar(WORKSPACE, 'bk-1', 'upsert')

    expect(result).toMatchObject({ synced: false })
    expect((result as { deferred?: boolean }).deferred).toBeUndefined()
    expect(state.queued).toHaveLength(0)
    expect(state.booking!.calendar_sync_status).toBe('failed')
  })

  it('records the external id before claiming success', async () => {
    zoho.create.mockResolvedValue('evt-123')

    const result = await syncBookingToCalendar(WORKSPACE, 'bk-1', 'upsert')

    expect(result).toMatchObject({ synced: true, action: 'create', event_id: 'evt-123' })
    expect(state.booking!.zoho_event_id).toBe('evt-123')
    expect(state.booking!.calendar_sync_status).toBe('synced')
  })

  it('distinguishes "no calendar connected" from "never tried"', async () => {
    state.hasAccount = false
    await syncBookingToCalendar(WORKSPACE, 'bk-1', 'upsert')
    expect(state.booking!.calendar_sync_status).toBe('not_applicable')
    expect(state.queued).toHaveLength(0)
  })

  it('does nothing when the owner has calendar sync switched off', async () => {
    state.syncCalendar = false
    await syncBookingToCalendar(WORKSPACE, 'bk-1', 'upsert')
    expect(zoho.create).not.toHaveBeenCalled()
    expect(state.queued).toHaveLength(0)
  })
})

// ── the reported failure ────────────────────────────────────────────────────

describe('scenario: add_internal_note fails (the 2026-08-11 Mrs. Max exchange)', () => {
  /**
   * The transcript this reproduces:
   *
   *   Mrs. Max:  yes please              [add a note on Christina's thread]
   *   Caye:      Hmm, ran into a technical error on that one. I'd recommend
   *              jotting it down on your end for now — North Bimini Heritage
   *              Tour, Private, 2 guests, Aug 20th at 10am, paid, pickup at
   *              Resorts World Casino tram stop. I'll flag this to the team.
   *
   * Root cause was a bad enum literal, fixed separately in c381858. These
   * assertions cover the OTHER half: what the system does when a write fails
   * for any reason at all.
   */

  function noteTool(impl: () => Promise<ToolResult>): Tool<never> {
    return {
      name: 'add_internal_note',
      description: 'test',
      inputSchema: { type: 'object', properties: {} },
      risk: 'low',
      roles: ['owner'],
      modes: ['back-office'],
      execute: impl as unknown as Tool<never>['execute'],
    } as Tool<never>
  }

  const ctx: ToolContext = {
    workspaceId: WORKSPACE,
    callerRole: 'owner',
    operatorId: 3,
    requestId: 'req-mrs-max',
  }

  it('retries a transient note failure instead of surrendering on the first error', async () => {
    let calls = 0
    const tool = noteTool(async () => {
      calls += 1
      if (calls === 1) throw new Error('ETIMEDOUT')
      return { ok: true, data: { note_added: true } }
    })

    const { result } = await runToolWithRecovery(tool, { note: 'x' }, ctx, { mode: 'back-office' })

    expect(calls).toBe(2)
    expect(result.ok).toBe(true)
  })

  it('instructs the model never to hand the work back to the owner', async () => {
    // This is the assertion the brief actually asked for. The model is told,
    // in the tool result itself, what it may and may not say.
    const tool = noteTool(async () => {
      throw { code: '22P02', message: 'invalid input value for enum sender_type: "system"' }
    })

    const { result } = await runToolWithRecovery(tool, { note: 'x' }, ctx, { mode: 'back-office' })
    const payload = stripForModel(result) as Record<string, unknown>
    payload.how_to_report_this = guidanceFor(result.status, result.deferred === true)

    const guidance = String(payload.how_to_report_this)
    // Wording only — same prohibition as orchestrator.test.ts's matching
    // assertion, phrased in the current guidance text as "never ask the
    // operator to do the failed work themselves" rather than "...do it
    // themselves".
    expect(guidance).toMatch(/never ask the operator to do the failed work themselves/i)
    expect(guidance).toMatch(/did not go through/i)
    expect(guidance).toMatch(/you are on it/i)
  })

  it('does not put the internal error code in front of the model', async () => {
    // "jotting it down on your end" came with "ran into a technical error";
    // the fix for the second half is that the mechanism never reaches the
    // model to be repeated in the first place.
    const tool = noteTool(async () => {
      throw { code: '22P02', message: 'invalid input value for enum sender_type: "system"' }
    })

    const { result } = await runToolWithRecovery(tool, { note: 'x' }, ctx, { mode: 'back-office' })
    const serialised = JSON.stringify(stripForModel(result))

    expect(serialised).not.toContain('22P02')
    expect(serialised).not.toContain('sender_type')
    expect(serialised).not.toContain('PG_')
  })

  it('reports a deferred write as done, not as an error', async () => {
    // is_error on a deferred result is what invites the apologetic framing.
    const { deferred } = await import('./tools/result')
    const tool = noteTool(async () => deferred({ note_added: true }, 'Saved — syncing shortly.'))

    const { result } = await runToolWithRecovery(tool, { note: 'x' }, ctx, { mode: 'back-office' })

    expect(result.ok).toBe(true)
    expect(guidanceFor(result.status, true)).toMatch(/do not ask the operator to record anything/i)
  })
})

// ── interaction with the ETAG fix (a732dd6) ─────────────────────────────────

describe('scenario: the Zoho event was deleted directly in Zoho', () => {
  it('recreates rather than retrying an update that can never succeed', async () => {
    // a732dd6's ETAG lookup 404s and throws "no longer exists" with no HTTP
    // code in the message. Retrying six times cannot bring the event back,
    // and giving up leaves the booking absent from the owner's calendar.
    state.booking!.zoho_event_id = 'evt-deleted'
    zoho.update.mockRejectedValue(
      new Error('Zoho Calendar update failed: event evt-deleted no longer exists')
    )
    zoho.create.mockResolvedValue('evt-fresh')

    const result = await syncBookingToCalendar(WORKSPACE, 'bk-1', 'upsert')

    expect(result).toMatchObject({ synced: true, action: 'create', event_id: 'evt-fresh' })
    expect(state.booking!.zoho_event_id).toBe('evt-fresh')
    expect(state.queued).toHaveLength(0)
  })

  it('still defers a genuinely transient update failure', async () => {
    state.booking!.zoho_event_id = 'evt-1'
    zoho.update.mockRejectedValue(new Error('Zoho Calendar update failed (503): upstream'))

    const result = await syncBookingToCalendar(WORKSPACE, 'bk-1', 'upsert')

    expect(result).toMatchObject({ synced: false, deferred: true })
    expect(zoho.create).not.toHaveBeenCalled()
    expect(state.booking!.zoho_event_id).toBe('evt-1')
  })
})
