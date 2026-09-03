import { beforeEach, describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('./supabase-server', () => ({ createServiceClient: vi.fn() }))

const { getSuppressedAddresses, isAddressSuppressed, SOFT_BOUNCE_RETRY_LIMIT } = await import('./outreach-suppression')
const { createServiceClient } = await import('./supabase-server')

// Minimal double for the one query this module makes: a table select with
// eq/not chaining that resolves to a fixed row set. No insert/maybeSingle
// needed — getSuppressedAddresses is read-only.
function makeDb(rows: unknown[] | null, error: { message: string } | null = null) {
  const builder: Record<string, (...args: unknown[]) => unknown> & PromiseLike<{ data: unknown; error: unknown }> = {
    select: () => builder,
    eq: () => builder,
    not: () => builder,
    then: (onfulfilled: (value: { data: unknown; error: unknown }) => unknown) =>
      Promise.resolve({ data: rows, error }).then(onfulfilled),
  } as never
  return { from: () => builder }
}

beforeEach(() => vi.clearAllMocks())

describe('getSuppressedAddresses', () => {
  it('suppresses an address on a single hard bounce', async () => {
    vi.mocked(createServiceClient).mockReturnValue(
      makeDb([{ bounced_recipient: 'dead@example.com', classification: 'hard' }]) as never
    )
    const result = await getSuppressedAddresses('ws-a', ['dead@example.com', 'ok@example.com'])
    expect(result.get('dead@example.com')).toEqual({ suppressed: true, reason: 'hard_bounce' })
    expect(result.has('ok@example.com')).toBe(false)
  })

  it(`tolerates fewer than ${SOFT_BOUNCE_RETRY_LIMIT} soft bounces`, async () => {
    const rows = Array.from({ length: SOFT_BOUNCE_RETRY_LIMIT - 1 }, () => ({
      bounced_recipient: 'full@example.com', classification: 'soft',
    }))
    vi.mocked(createServiceClient).mockReturnValue(makeDb(rows) as never)
    const result = await getSuppressedAddresses('ws-a', ['full@example.com'])
    expect(result.has('full@example.com')).toBe(false)
  })

  it(`suppresses after reaching the soft-bounce retry limit (${SOFT_BOUNCE_RETRY_LIMIT})`, async () => {
    const rows = Array.from({ length: SOFT_BOUNCE_RETRY_LIMIT }, () => ({
      bounced_recipient: 'full@example.com', classification: 'soft',
    }))
    vi.mocked(createServiceClient).mockReturnValue(makeDb(rows) as never)
    const result = await getSuppressedAddresses('ws-a', ['full@example.com'])
    expect(result.get('full@example.com')).toEqual({ suppressed: true, reason: 'repeated_soft_bounce' })
  })

  it('does not suppress on an unclassified ("unknown") bounce alone', async () => {
    vi.mocked(createServiceClient).mockReturnValue(
      makeDb([{ bounced_recipient: 'maybe@example.com', classification: 'unknown' }]) as never
    )
    const result = await getSuppressedAddresses('ws-a', ['maybe@example.com'])
    expect(result.has('maybe@example.com')).toBe(false)
  })

  it('a hard bounce wins even after enough soft bounces would also have crossed the limit', async () => {
    const rows = [
      { bounced_recipient: 'mixed@example.com', classification: 'soft' },
      { bounced_recipient: 'mixed@example.com', classification: 'soft' },
      { bounced_recipient: 'mixed@example.com', classification: 'soft' },
      { bounced_recipient: 'mixed@example.com', classification: 'hard' },
    ]
    vi.mocked(createServiceClient).mockReturnValue(makeDb(rows) as never)
    const result = await getSuppressedAddresses('ws-a', ['mixed@example.com'])
    expect(result.get('mixed@example.com')).toEqual({ suppressed: true, reason: 'hard_bounce' })
  })

  it('normalizes case and whitespace on both sides of the match', async () => {
    vi.mocked(createServiceClient).mockReturnValue(
      makeDb([{ bounced_recipient: 'dead@example.com', classification: 'hard' }]) as never
    )
    const result = await getSuppressedAddresses('ws-a', [' Dead@Example.com '])
    expect(result.get('dead@example.com')).toEqual({ suppressed: true, reason: 'hard_bounce' })
  })

  it('returns an empty map without querying when given no candidate emails', async () => {
    const db = makeDb([])
    vi.mocked(createServiceClient).mockReturnValue(db as never)
    const result = await getSuppressedAddresses('ws-a', [])
    expect(result.size).toBe(0)
  })

  it('fails open (returns empty map, does not throw) when the lookup errors', async () => {
    vi.mocked(createServiceClient).mockReturnValue(
      makeDb(null, { message: 'column "bounced_recipient" does not exist' }) as never
    )
    const result = await getSuppressedAddresses('ws-a', ['dead@example.com'])
    expect(result.size).toBe(0)
  })
})

describe('isAddressSuppressed', () => {
  it('reports suppressed for a hard-bounced address', async () => {
    vi.mocked(createServiceClient).mockReturnValue(
      makeDb([{ bounced_recipient: 'dead@example.com', classification: 'hard' }]) as never
    )
    expect(await isAddressSuppressed('ws-a', 'dead@example.com')).toEqual({ suppressed: true, reason: 'hard_bounce' })
  })

  it('reports not suppressed for an address with no bounce history', async () => {
    vi.mocked(createServiceClient).mockReturnValue(makeDb([]) as never)
    expect(await isAddressSuppressed('ws-a', 'clean@example.com')).toEqual({ suppressed: false, reason: null })
  })
})
