import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ToolContext } from '../types'

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
