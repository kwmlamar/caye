import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const mocks = vi.hoisted(() => ({
  findOwnedBooking: vi.fn(),
  maybeNotifyCustomer: vi.fn(),
  syncBookingToCalendar: vi.fn(),
}))

vi.mock('./_booking-helpers', () => ({
  findOwnedBooking: mocks.findOwnedBooking,
  maybeNotifyCustomer: mocks.maybeNotifyCustomer,
  HIGH_RISK_CONFIRMATION_PREAMBLE: 'preamble',
  NOTIFY_BODY_DESCRIPTION: 'notify body',
  NOTIFY_CUSTOMER_DESCRIPTION: 'notify customer',
}))

vi.mock('@/lib/calendar-sync', () => ({
  syncBookingToCalendar: mocks.syncBookingToCalendar,
}))

// Simulates what the UPDATE actually persisted — set per test to prove the
// tool verifies the real row rather than trusting args.new_date/new_time.
let persistedRow: { booking_date: string; booking_time: string } | null = {
  booking_date: '2026-08-26',
  booking_time: '10:00:00',
}
let updateError: string | null = null

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({
    from(table: string) {
      if (table !== 'bookings') throw new Error(`unexpected table: ${table}`)
      return {
        update: () => ({
          eq: async () => ({ error: updateError ? { message: updateError } : null }),
        }),
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: persistedRow, error: null }),
          }),
        }),
      }
    },
  }),
}))

import { rescheduleBooking } from './reschedule-booking'

const ctx = { workspaceId: 'ws-1', callerRole: 'owner' as const, operatorId: 1, requestId: 'req-1' }

describe('reschedule_booking — 2026-08-26 Sonja Pettus incident hardening', () => {
  beforeEach(() => {
    mocks.findOwnedBooking.mockReset()
    mocks.maybeNotifyCustomer.mockReset()
    mocks.syncBookingToCalendar.mockReset()
    mocks.findOwnedBooking.mockResolvedValue({
      ok: true,
      booking: {
        id: 'booking-sonja',
        status: 'confirmed',
        booking_date: '2026-08-26',
        booking_time: '09:00:00',
        customer_name: 'Sonja Pettus',
        conversation_id: 'conv-sonja',
        service_id: 'svc-1',
        number_of_people: 4,
      },
    })
    mocks.syncBookingToCalendar.mockResolvedValue({ synced: true, event_id: 'evt-1' })
    mocks.maybeNotifyCustomer.mockResolvedValue({ sent: true, channel: 'email' })
    persistedRow = { booking_date: '2026-08-26', booking_time: '10:00:00' }
    updateError = null
  })

  it('happy path: mutates, VERIFIES the persisted row, syncs calendar, and notifies from the VERIFIED state — not from args', async () => {
    const result = await rescheduleBooking.execute(
      { booking_id: 'booking-sonja', new_date: '2026-08-26', new_time: '10:00', notification_body: 'Tour Start Time: 10:00 a.m.' },
      ctx
    )

    expect(result.ok).toBe(true)
    expect(mocks.maybeNotifyCustomer).toHaveBeenCalledTimes(1)
    const data = (result as { data: Record<string, unknown> }).data
    expect(data.new_date).toBe('2026-08-26')
    expect(data.new_time).toBe('10:00')
    expect(data.customer_notified).toBe(true)
  })

  it('does not claim success — and does not notify — when the update does not verifiably persist', async () => {
    persistedRow = { booking_date: '2026-08-26', booking_time: '09:00:00' } // still the OLD time
    const result = await rescheduleBooking.execute(
      { booking_id: 'booking-sonja', new_date: '2026-08-26', new_time: '10:00', notification_body: 'Tour Start Time: 10:00 a.m.' },
      ctx
    )

    expect(result.ok).toBe(false)
    expect(mocks.maybeNotifyCustomer).not.toHaveBeenCalled()
  })

  it('does not claim success when the raw update call itself errors', async () => {
    updateError = 'connection reset'
    const result = await rescheduleBooking.execute(
      { booking_id: 'booking-sonja', new_date: '2026-08-26', new_time: '10:00' },
      ctx
    )
    expect(result.ok).toBe(false)
    expect(mocks.maybeNotifyCustomer).not.toHaveBeenCalled()
  })

  it('blocks a stale/mismatched notification_body instead of sending it, while the booking mutation itself still reports success', async () => {
    persistedRow = { booking_date: '2026-08-26', booking_time: '10:00:00' } // correctly rescheduled
    const result = await rescheduleBooking.execute(
      {
        booking_id: 'booking-sonja',
        new_date: '2026-08-26',
        new_time: '10:00',
        // Model composed stale/wrong notification text referencing the OLD time.
        notification_body: 'Your tour is confirmed for tomorrow at 9:00 a.m.',
      },
      ctx
    )

    expect(result.ok).toBe(true) // the booking record IS correctly 10:00 now
    expect(mocks.maybeNotifyCustomer).not.toHaveBeenCalled() // but the bad text was never sent
    const data = (result as { data: Record<string, unknown> }).data
    expect(data.customer_notified).toBe(false)
    expect(String(data.notification_error)).toMatch(/09:00|9:00/)
  })

  it('booking mutation succeeds even when calendar sync fails afterward — never rolled back for that', async () => {
    mocks.syncBookingToCalendar.mockResolvedValue({ synced: false, deferred: true, reason: 'zoho timeout' })
    const result = await rescheduleBooking.execute(
      { booking_id: 'booking-sonja', new_date: '2026-08-26', new_time: '10:00' },
      ctx
    )
    expect(result.ok).toBe(true)
    const data = (result as { data: Record<string, unknown> }).data
    expect(data.calendar_synced).toBe(false)
    expect(data.calendar_sync_status).toBe('pending')
    // The record itself is still correctly updated — calendar lag doesn't
    // undo the authoritative booking_time.
    expect(data.new_time).toBe('10:00')
  })

  it('booking mutation succeeds even when notification dispatch itself fails — record is not rolled back for a failed send', async () => {
    mocks.maybeNotifyCustomer.mockResolvedValue({ sent: false, error: 'provider timeout' })
    const result = await rescheduleBooking.execute(
      { booking_id: 'booking-sonja', new_date: '2026-08-26', new_time: '10:00', notification_body: 'Tour Start Time: 10:00 a.m.' },
      ctx
    )
    expect(result.ok).toBe(true)
    const data = (result as { data: Record<string, unknown> }).data
    expect(data.new_time).toBe('10:00')
    expect(data.customer_notified).toBe(false)
    expect(data.notification_error).toBe('provider timeout')
  })

  it('never attempts a mutation when the booking cannot be resolved (not found / not owned)', async () => {
    mocks.findOwnedBooking.mockResolvedValue({ ok: false, error: 'Booking not found in this workspace' })
    const result = await rescheduleBooking.execute(
      { booking_id: 'does-not-exist', new_date: '2026-08-26', new_time: '10:00' },
      ctx
    )
    expect(result.ok).toBe(false)
    expect(mocks.syncBookingToCalendar).not.toHaveBeenCalled()
    expect(mocks.maybeNotifyCustomer).not.toHaveBeenCalled()
  })

  it('refuses to reschedule an already-cancelled booking', async () => {
    mocks.findOwnedBooking.mockResolvedValue({
      ok: true,
      booking: {
        id: 'booking-sonja', status: 'cancelled', booking_date: '2026-08-20', booking_time: '09:00:00',
        customer_name: 'Sonja Pettus', conversation_id: 'conv-sonja', service_id: 'svc-1', number_of_people: 4,
      },
    })
    const result = await rescheduleBooking.execute(
      { booking_id: 'booking-sonja', new_date: '2026-08-26', new_time: '10:00' },
      ctx
    )
    expect(result.ok).toBe(false)
    expect(mocks.syncBookingToCalendar).not.toHaveBeenCalled()
  })
})
