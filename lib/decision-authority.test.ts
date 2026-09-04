import { describe, expect, it } from 'vitest'
import { authorityScopeMatches, classifyHighRiskDecision, requiredAuthorityForDomain, resolveDecisionAuthorityFromPrincipals, type DecisionPrincipal } from './decision-authority'

const verified = '2026-08-30T00:00:00.000Z'
function principal(overrides: Partial<DecisionPrincipal> & Pick<DecisionPrincipal, 'id' | 'role'>): DecisionPrincipal {
  return {
    id: overrides.id,
    name: overrides.name ?? `operator-${overrides.id}`,
    role: overrides.role,
    verifiedAt: overrides.verifiedAt === undefined ? verified : overrides.verifiedAt,
    directScopes: overrides.directScopes ?? [],
    delegatedScopes: overrides.delegatedScopes ?? [],
    preferredDelegation: overrides.preferredDelegation ?? false,
  }
}

describe('classifyHighRiskDecision', () => {
  // A null domain does not disable the confirmation round trip, but it does skip authority
  // resolution entirely -- so an actor who is not authorized is never routed to the operator
  // who can approve. send_freight_document emails an external forwarder an attachment built
  // from this workspace's purchase evidence, the same shape as send_reply/draft_in_inbox.
  it('classifies sending a freight document as customer communication', () => {
    expect(classifyHighRiskDecision('send_freight_document')).toBe('customer_communication')
    expect(requiredAuthorityForDomain('customer_communication')).toBe('business.customer.communication')
  })

  it('returns null for a tool that is not high-risk mapped', () => {
    expect(classifyHighRiskDecision('get_freight_workflows')).toBeNull()
  })
})

describe('authorityScopeMatches', () => {
  it('supports exact and hierarchical explicit scopes without prefix accidents', () => {
    expect(authorityScopeMatches('business.*', 'business.booking.capacity')).toBe(true)
    expect(authorityScopeMatches('business.booking.*', 'business.booking.capacity')).toBe(true)
    expect(authorityScopeMatches('business.booking.manage', 'business.booking.manage')).toBe(true)
    expect(authorityScopeMatches('business.book*', 'business.booking.manage')).toBe(false)
    expect(authorityScopeMatches('routing.*', 'business.outreach.control')).toBe(false)
  })
})

describe('resolveDecisionAuthorityFromPrincipals', () => {
  it('does not turn a founder conversation initiator into the customer business approver', () => {
    const result = resolveDecisionAuthorityFromPrincipals({
      actorOperatorId: 13,
      requiredAuthority: 'business.booking.capacity',
      principals: [
        principal({ id: 1, role: 'owner', name: 'Verified owner', directScopes: ['business.*'] }),
        principal({ id: 13, role: 'founder', name: 'Platform founder', directScopes: [] }),
        principal({ id: 22, role: 'owner', name: 'Unverified purported owner', verifiedAt: null, directScopes: ['business.*'] }),
      ],
    })
    expect(result.actorAuthorized).toBe(false)
    expect(result.preferredDecisionOwner?.id).toBe(1)
  })

  it('lets a verified owner decide under explicit owner scopes', () => {
    const result = resolveDecisionAuthorityFromPrincipals({
      actorOperatorId: 1,
      requiredAuthority: 'business.payment.policy',
      principals: [principal({ id: 1, role: 'owner', directScopes: ['business.*'] })],
    })
    expect(result.actorAuthorized).toBe(true)
    expect(result.preferredDecisionOwner?.id).toBe(1)
  })

  it('supports an explicit delegated operator and prefers a preferred delegation', () => {
    const result = resolveDecisionAuthorityFromPrincipals({
      actorOperatorId: 7,
      requiredAuthority: 'business.outreach.control',
      principals: [
        principal({ id: 1, role: 'owner', directScopes: ['business.*'] }),
        principal({ id: 7, role: 'staff', delegatedScopes: ['business.outreach.control'], preferredDelegation: true }),
      ],
    })
    expect(result.actorAuthorized).toBe(true)
    expect(result.preferredDecisionOwner?.id).toBe(7)
  })

  it('fails closed for an unverified purported owner', () => {
    const result = resolveDecisionAuthorityFromPrincipals({
      actorOperatorId: 22,
      requiredAuthority: 'business.booking.capacity',
      principals: [principal({ id: 22, role: 'owner', verifiedAt: null, directScopes: ['business.*'] })],
    })
    expect(result.actorAuthorized).toBe(false)
    expect(result.preferredDecisionOwner).toBeNull()
  })

  it('resolves conflicting authorized roles deterministically', () => {
    const result = resolveDecisionAuthorityFromPrincipals({
      actorOperatorId: 99,
      requiredAuthority: 'business.policy',
      principals: [
        principal({ id: 8, role: 'staff', delegatedScopes: ['business.policy'] }),
        principal({ id: 4, role: 'owner', directScopes: ['business.*'] }),
        principal({ id: 3, role: 'founder', directScopes: ['business.policy'] }),
      ],
    })
    expect(result.authorizedPrincipals.map((p) => p.id)).toEqual([4, 8, 3])
    expect(result.preferredDecisionOwner?.id).toBe(4)
  })

  it('fails closed when nobody has the required authority', () => {
    const result = resolveDecisionAuthorityFromPrincipals({
      actorOperatorId: 13,
      requiredAuthority: 'business.payment.policy',
      principals: [principal({ id: 13, role: 'founder', directScopes: ['routing.*'] })],
    })
    expect(result.actorAuthorized).toBe(false)
    expect(result.authorizedPrincipals).toEqual([])
    expect(result.preferredDecisionOwner).toBeNull()
  })

  it('does not accept a cross-workspace actor absent from the workspace principal set', () => {
    const result = resolveDecisionAuthorityFromPrincipals({
      actorOperatorId: 500,
      requiredAuthority: 'business.team.manage',
      principals: [principal({ id: 1, role: 'owner', directScopes: ['business.*'] })],
    })
    expect(result.actor).toBeNull()
    expect(result.actorAuthorized).toBe(false)
    expect(result.preferredDecisionOwner?.id).toBe(1)
  })

  it('models revoked delegation by excluding revoked grants from effective delegatedScopes', () => {
    const result = resolveDecisionAuthorityFromPrincipals({
      actorOperatorId: 7,
      requiredAuthority: 'business.outreach.control',
      principals: [principal({ id: 7, role: 'staff', delegatedScopes: [] })],
    })
    expect(result.actorAuthorized).toBe(false)
    expect(result.preferredDecisionOwner).toBeNull()
  })
})
