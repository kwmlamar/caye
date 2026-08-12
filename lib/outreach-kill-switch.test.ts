import { describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('./supabase-server', () => ({ createServiceClient: () => ({}) }))
vi.mock('./whatsapp/outbound', () => ({ sendFreeFormWhatsApp: vi.fn() }))

const { shouldTripKillSwitch } = await import('./outreach-kill-switch')

describe('shouldTripKillSwitch', () => {
  it('does not trip below the threshold', () => {
    expect(shouldTripKillSwitch(4, 5)).toBe(false)
  })

  it('trips exactly at the threshold', () => {
    expect(shouldTripKillSwitch(5, 5)).toBe(true)
  })

  it('trips above the threshold', () => {
    expect(shouldTripKillSwitch(9, 5)).toBe(true)
  })

  it('does not trip with zero bounces', () => {
    expect(shouldTripKillSwitch(0, 5)).toBe(false)
  })
})
