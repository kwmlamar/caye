import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))

let customerMessages: { content: string }[] = []
let services: { id: string; name: string }[] = []
let overrides: { id: string; date_iso: string; effect: string; min_party: number | null; restricted_variant: string | null; note: string | null }[] = []
let tiers: { variant: string | null }[] = []

const supabase = {
  from(table: string) {
    if (table === 'unified_messages') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              eq: () => ({
                order: () => ({
                  limit: async () => ({ data: customerMessages, error: null }),
                }),
              }),
            }),
          }),
        }),
      }
    }
    if (table === 'booking_services') {
      return { select: () => ({ eq: () => ({ eq: async () => ({ data: services, error: null }) }) }) }
    }
    if (table === 'service_date_overrides') {
      return {
        select: () => ({
          eq: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ limit: async () => ({ data: overrides, error: null }) }) }) }) }),
        }),
      }
    }
    if (table === 'service_pricing_tiers') {
      return { select: () => ({ eq: () => ({ eq: async () => ({ data: tiers, error: null }) }) }) }
    }
    throw new Error(`unexpected table: ${table}`)
  },
} as unknown as Parameters<typeof import('./date-override-revalidation').staleDateOverrideConflict>[0]

const { staleDateOverrideConflict } = await import('./date-override-revalidation')

beforeEach(() => {
  customerMessages = []
  services = []
  overrides = []
  tiers = []
})

const FULL_BIMINI_INTAKE = [
  'Tour: Full Bimini Experience',
  'DateISO: 2026-09-05',
  'Guests: 2',
].join('\n')

describe('staleDateOverrideConflict', () => {
  it('returns null when the customer thread has no extractable service/date (nothing to revalidate)', async () => {
    customerMessages = [{ content: 'Hi, just wondering about your tours in general.' }]
    const result = await staleDateOverrideConflict(supabase, 'ws-1', 'conv-1', 'Here are some options!')
    expect(result).toBeNull()
  })

  it('returns null when the service cannot be matched with high confidence', async () => {
    customerMessages = [{ content: FULL_BIMINI_INTAKE }]
    services = [] // nothing to match against
    const result = await staleDateOverrideConflict(supabase, 'ws-1', 'conv-1', 'Sure, we can do that!')
    expect(result).toBeNull()
  })

  it('returns null when no override exists for that service/date (the common case)', async () => {
    customerMessages = [{ content: FULL_BIMINI_INTAKE }]
    services = [{ id: 'svc-1', name: 'Full Bimini Experience' }]
    overrides = []
    const result = await staleDateOverrideConflict(supabase, 'ws-1', 'conv-1', 'Yes, September 5th works great!')
    expect(result).toBeNull()
  })

  // Real scenario from the 2026-08-26 historical-learning audit: a router-
  // learned "unavailable" override lands mid-turn; the draft, composed
  // before that, doesn't refuse.
  it('flags a stale draft that does not refuse when the date just became fully unavailable', async () => {
    customerMessages = [{ content: FULL_BIMINI_INTAKE }]
    services = [{ id: 'svc-1', name: 'Full Bimini Experience' }]
    overrides = [
      { id: 'ov-1', date_iso: '2026-09-05', effect: 'unavailable', min_party: null, restricted_variant: null, note: 'Boat in maintenance.' },
    ]
    const result = await staleDateOverrideConflict(
      supabase,
      'ws-1',
      'conv-1',
      'Yes! September 5th at 10am works perfectly for the Full Bimini Experience, see you then.'
    )
    expect(result).toContain('unavailable')
    expect(result).toContain('2026-09-05')
  })

  it('does NOT flag a draft that already reads as a refusal for the newly-unavailable date', async () => {
    customerMessages = [{ content: FULL_BIMINI_INTAKE }]
    services = [{ id: 'svc-1', name: 'Full Bimini Experience' }]
    overrides = [
      { id: 'ov-1', date_iso: '2026-09-05', effect: 'unavailable', min_party: null, restricted_variant: null, note: null },
    ]
    const result = await staleDateOverrideConflict(
      supabase,
      'ws-1',
      'conv-1',
      "Unfortunately the Full Bimini Experience is not available on September 5th — here are some alternatives."
    )
    expect(result).toBeNull()
  })

  it('flags a stale draft that offers a different variant than the newly-restricted one', async () => {
    customerMessages = [{ content: FULL_BIMINI_INTAKE }]
    services = [{ id: 'svc-1', name: 'Full Bimini Experience' }]
    overrides = [
      { id: 'ov-1', date_iso: '2026-09-05', effect: 'variant_only', min_party: null, restricted_variant: 'private', note: null },
    ]
    tiers = [{ variant: 'shared' }, { variant: 'private' }]
    const result = await staleDateOverrideConflict(
      supabase,
      'ws-1',
      'conv-1',
      'The shared rate for September 5th is $199 per person — want me to hold your spot?'
    )
    expect(result).toContain('private')
  })

  it('does NOT flag a draft that already reflects the variant restriction', async () => {
    customerMessages = [{ content: FULL_BIMINI_INTAKE }]
    services = [{ id: 'svc-1', name: 'Full Bimini Experience' }]
    overrides = [
      { id: 'ov-1', date_iso: '2026-09-05', effect: 'variant_only', min_party: null, restricted_variant: 'private', note: null },
    ]
    tiers = [{ variant: 'shared' }, { variant: 'private' }]
    const result = await staleDateOverrideConflict(
      supabase,
      'ws-1',
      'conv-1',
      'Only the private option is available on September 5th, at $450 total for 2.'
    )
    expect(result).toBeNull()
  })
})
