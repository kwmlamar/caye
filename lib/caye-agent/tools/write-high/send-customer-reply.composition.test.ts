import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * send-customer-reply.composition.test.ts
 *
 * Structural proof that PR #133 (operator-learning-router,
 * service_date_overrides content-freshness) and PR #132
 * (conversation-execution-coordination) compose in the required order in
 * the ACTUAL merged file — not a mocked approximation of it. Reads the real
 * source rather than re-exercising send_customer_reply's full dependency
 * graph (already covered: date-override-revalidation.test.ts proves the
 * CONTENT logic in isolation; send-customer-reply.test.ts proves the
 * broader guard chain against a real, working mock and continues to pass
 * unmodified after this merge).
 *
 * Required order (per the composition review): load authoritative state ->
 * apply date-specific learned state -> content freshness check -> validate
 * conversation execution ownership -> dispatch.
 */
describe('send_customer_reply — #132/#133 composition ordering (real source)', () => {
  const src = readFileSync(
    join(__dirname, 'send-customer-reply.ts'),
    'utf8'
  )

  it('imports both the date-override freshness check and the execution-coordination guard', () => {
    expect(src).toContain("import { staleDateOverrideConflict } from '../../date-override-revalidation'")
    expect(src).toMatch(/import \{[^}]*validateConversationExecution[^}]*\} from '@\/lib\/conversation-execution'/)
  })

  it('calls staleDateOverrideConflict strictly BEFORE validateConversationExecution', () => {
    const staleCallIdx = src.indexOf('staleDateOverrideConflict(supabase,')
    const validateCallIdx = src.indexOf('validateConversationExecution({')
    expect(staleCallIdx).toBeGreaterThan(-1)
    expect(validateCallIdx).toBeGreaterThan(-1)
    expect(staleCallIdx).toBeLessThan(validateCallIdx)
  })

  it('calls validateConversationExecution strictly BEFORE dispatchOperatorReply', () => {
    const validateCallIdx = src.indexOf('validateConversationExecution({')
    const dispatchCallIdx = src.indexOf('dispatchOperatorReply(')
    expect(validateCallIdx).toBeGreaterThan(-1)
    expect(dispatchCallIdx).toBeGreaterThan(-1)
    expect(validateCallIdx).toBeLessThan(dispatchCallIdx)
  })

  it('the stale-date-override rejection returns before entering the execution try/catch block, so a doomed send never claims/burns the execution ownership check', () => {
    const staleCallIdx = src.indexOf('staleDateOverrideConflict(supabase,')
    const tryBlockIdx = src.indexOf('let dispatched = false')
    expect(staleCallIdx).toBeGreaterThan(-1)
    expect(tryBlockIdx).toBeGreaterThan(-1)
    expect(staleCallIdx).toBeLessThan(tryBlockIdx)
  })

  it('the full required order — authoritative-state guards, then freshness, then execution ownership, then dispatch — holds in one strictly increasing sequence', () => {
    const positions = {
      businessFacts: src.indexOf('fetchBusinessFacts(ctx.workspaceId)'),
      paymentFigureGuard: src.indexOf('detectUnverifiedPaymentFigure('),
      bookingStatusGuard: src.indexOf('validateAuthoritativeBookingStatusClaims('),
      evidenceDisposition: src.indexOf('decideDisposition({'),
      staleDateOverride: src.indexOf('staleDateOverrideConflict(supabase,'),
      executionValidate: src.indexOf('validateConversationExecution({'),
      dispatch: src.indexOf('dispatchOperatorReply('),
    }
    for (const [name, idx] of Object.entries(positions)) {
      expect(idx, `${name} not found in send-customer-reply.ts`).toBeGreaterThan(-1)
    }
    const ordered = Object.values(positions)
    for (let i = 1; i < ordered.length; i++) {
      expect(ordered[i]).toBeGreaterThan(ordered[i - 1])
    }
  })
})
