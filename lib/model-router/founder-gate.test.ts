import { describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))
import { assertFounderRouterAccess, FounderRouterAccessError } from './founder-gate'
import type { FounderRouterContext } from './types'

const LAMAR_ID = '29227a12-ca82-4796-a9c4-30ec0c6fa0e4' // classicalsineus@gmail.com, from lib/founder.ts
const CUSTOMER_ID = 'b3f1a111-1111-1111-1111-111111111111'

describe('assertFounderRouterAccess', () => {
  it('allows a real founder id with a thread', () => {
    const ctx: FounderRouterContext = { founderUserId: LAMAR_ID, threadId: 'thread-1' }
    expect(() => assertFounderRouterAccess(ctx)).not.toThrow()
  })

  it('rejects a non-founder (customer/operator) id — this is the boundary customers and Mrs. Max must never cross', () => {
    const ctx: FounderRouterContext = { founderUserId: CUSTOMER_ID, threadId: 'thread-1' }
    expect(() => assertFounderRouterAccess(ctx)).toThrow(FounderRouterAccessError)
  })

  it('rejects a null context — cron/webhook call sites that never built one', () => {
    expect(() => assertFounderRouterAccess(null)).toThrow(FounderRouterAccessError)
  })

  it('rejects an undefined context', () => {
    expect(() => assertFounderRouterAccess(undefined)).toThrow(FounderRouterAccessError)
  })

  it('rejects an empty founderUserId even if somehow passed', () => {
    const ctx = { founderUserId: '', threadId: 'thread-1' } as FounderRouterContext
    expect(() => assertFounderRouterAccess(ctx)).toThrow(FounderRouterAccessError)
  })

  it('rejects a founder id spoofed with extra characters (not an exact allowlist match)', () => {
    const ctx: FounderRouterContext = { founderUserId: `${LAMAR_ID}x`, threadId: 'thread-1' }
    expect(() => assertFounderRouterAccess(ctx)).toThrow(FounderRouterAccessError)
  })

  it('rejects a valid founder id missing a threadId — router is thread-scoped, not general purpose', () => {
    const ctx = { founderUserId: LAMAR_ID, threadId: '' } as FounderRouterContext
    expect(() => assertFounderRouterAccess(ctx)).toThrow(FounderRouterAccessError)
  })

  it('honors NEXT_PUBLIC_FOUNDER_USER_IDS env overrides via the shared lib/founder.ts allowlist', () => {
    // lib/founder.ts reads this at module load, so this test only documents
    // the contract (isFounderUserId is single-sourced there); it does not
    // attempt to mutate env after import since FOUNDER_USER_IDS is computed once.
    const ctx: FounderRouterContext = { founderUserId: LAMAR_ID, threadId: 'thread-1' }
    expect(() => assertFounderRouterAccess(ctx)).not.toThrow()
  })
})
