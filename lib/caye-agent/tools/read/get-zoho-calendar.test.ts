import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ToolContext } from '../types'

vi.mock('server-only', () => ({}))

const listZohoCalendarEventsMock = vi.fn(async (_workspaceId: string, _from: string, _to: string) => [
  {
    uid: 'zoho-1',
    title: 'Private tour — Rayna Morgan (2)',
    description: 'Booked via Caye',
    isAllDay: false,
    startDate: '2026-09-01',
    startTime: '10:00',
    durationMinutes: 120,
  },
])
vi.mock('@/lib/zoho-calendar', () => ({
  listZohoCalendarEvents: (workspaceId: string, from: string, to: string) =>
    listZohoCalendarEventsMock(workspaceId, from, to),
}))

vi.mock('@/lib/booking-time', () => ({
  businessLocalDate: () => '2026-09-01',
}))

import { getZohoCalendar } from './get-zoho-calendar'

const ctx: ToolContext = {
  workspaceId: 'ws1',
  callerRole: 'owner',
  requestId: 'req1',
  workspaceTimezone: 'America/Nassau',
}

describe('getZohoCalendar', () => {
  beforeEach(() => listZohoCalendarEventsMock.mockClear())

  it('reads the connected live Zoho calendar for the requested range', async () => {
    const result = await getZohoCalendar.execute({ date: '2026-09-01', end_date: '2026-09-02' }, ctx)

    expect(listZohoCalendarEventsMock).toHaveBeenCalledWith('ws1', '2026-09-01', '2026-09-02')
    expect(result).toMatchObject({
      ok: true,
      data: { count: 1, events: [{ id: 'zoho-1', time: '10:00' }] },
    })
  })

  it('uses the business-local date when no date is provided', async () => {
    await getZohoCalendar.execute({}, ctx)
    expect(listZohoCalendarEventsMock).toHaveBeenCalledWith('ws1', '2026-09-01', '2026-09-01')
  })

  it('rejects malformed date input before calling Zoho', async () => {
    const result = await getZohoCalendar.execute({ date: 'tomorrow' }, ctx)
    expect(result.ok).toBe(false)
    expect(listZohoCalendarEventsMock).not.toHaveBeenCalled()
  })
})
