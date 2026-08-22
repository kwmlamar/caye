import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ToolContext } from '../types'
import type { SyncResult } from '@/lib/calendar-sync'

vi.mock('server-only', () => ({}))

vi.mock('../write-low/_guards', () => ({
  assertConversationOwnedByWorkspace: vi.fn(async () => ({ ok: true })),
}))

interface FakeCreateBookingResult {
  success: boolean
  booking_id?: string
  error?: string
}
const createBookingFromCayeMock = vi.fn(
  async (
    _workspaceId: string,
    _conversationId: string | null,
    _input: unknown,
    _fallbackEmail: string | null
  ): Promise<FakeCreateBookingResult> => ({ success: true, booking_id: 'b1' })
)
vi.mock('@/lib/caye-reply', () => ({
  createBookingFromCaye: (workspaceId: string, conversationId: string | null, input: unknown, fallbackEmail: string | null) =>
    createBookingFromCayeMock(workspaceId, conversationId, input, fallbackEmail),
}))

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({}),
}))

const syncBookingToCalendarMock = vi.fn(
  async (_workspaceId: string, _bookingId: string, _action: 'upsert' | 'delete'): Promise<SyncResult> => ({
    synced: true,
    action: 'create',
    event_id: 'zoho-event-1',
  })
)
vi.mock('@/lib/calendar-sync', () => ({
  syncBookingToCalendar: (workspaceId: string, bookingId: string, action: 'upsert' | 'delete') =>
    syncBookingToCalendarMock(workspaceId, bookingId, action),
}))

import { createCustomerBooking } from './create-customer-booking'

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceId: 'ws1',
    callerRole: 'owner',
    requestId: 'req1',
    evidenceCollected: [],
    ...overrides,
  }
}

const fullArgs = {
  conversation_id: 'c1',
  customer_name: 'Rayna Morgan',
  customer_email: 'rayna@example.com',
  service_id: 'svc1',
  booking_date: '2026-09-01',
  booking_time: '10:00',
  number_of_people: 2,
}

describe('createCustomerBooking', () => {
  beforeEach(() => {
    createBookingFromCayeMock.mockClear()
    syncBookingToCalendarMock.mockClear()
    syncBookingToCalendarMock.mockResolvedValue({ synced: true, action: 'create', event_id: 'zoho-event-1' })
  })

  it('creates the owner-approved booking as status=pending', async () => {
    const result = await createCustomerBooking.execute(fullArgs, ctx())
    expect(result.ok).toBe(true)
    expect(createBookingFromCayeMock).toHaveBeenCalledWith(
      'ws1',
      'c1',
      expect.objectContaining({ status: 'pending', customer_name: 'Rayna Morgan' }),
      'rayna@example.com'
    )
    expect(syncBookingToCalendarMock).toHaveBeenCalledWith('ws1', 'b1', 'upsert')
    expect(result.data).toMatchObject({
      calendar_synced: true,
      calendar_sync_status: 'synced',
      calendar_event_id: 'zoho-event-1',
    })
  })

  it('keeps the booking and reports a queued Zoho retry when Zoho is temporarily unavailable', async () => {
    syncBookingToCalendarMock.mockResolvedValueOnce({
      synced: false,
      deferred: true,
      reason: 'Zoho Calendar is temporarily unavailable',
    })

    const result = await createCustomerBooking.execute(fullArgs, ctx())

    expect(result.ok).toBe(true)
    expect(result.deferred).toBe(true)
    expect(result.data).toMatchObject({ calendar_synced: false, calendar_sync_status: 'pending' })
  })

  it('surfaces a duplicate-booking rejection from the canonical function as a CONFLICT, not a crash', async () => {
    createBookingFromCayeMock.mockResolvedValueOnce({ success: false, error: 'Already booked for this date.' })
    const result = await createCustomerBooking.execute(fullArgs, ctx())
    expect(result.ok).toBe(false)
    expect(result.status).toBe('CONFLICT')
  })

  it('is tagged high-risk and available to the operator workflow', () => {
    expect(createCustomerBooking.risk).toBe('high')
    expect(createCustomerBooking.modes).toEqual(['back-office'])
    expect(createCustomerBooking.roles).toEqual(['owner', 'founder'])
  })
})
