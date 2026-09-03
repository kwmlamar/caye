import { describe, expect, it } from 'vitest'
import { routeAttention, type RoutableOperator, resolveRoleOperatorId } from '@/lib/attention-routing'

// The real ODS roster shape (CAY dispatch fixtures). Omar is deliberately
// unverified — an estimate alert for him must come back unrouted, never
// silently redirected to someone else.
const WALLACE: RoutableOperator = { id: 32, name: 'Wallace', phone: '+12424708131', role: 'owner', verified: true }
const JAY: RoutableOperator = { id: 34, name: 'Jay', phone: '+12428250317', role: 'staff', verified: true }
const OMAR: RoutableOperator = { id: 35, name: 'Omar', phone: '+12424705294', role: 'staff', verified: false }
const LAMAR: RoutableOperator = { id: 31, name: 'Lamar', phone: '+13342219466', role: 'staff', verified: true }

const ROSTER: RoutableOperator[] = [WALLACE, JAY, OMAR, LAMAR]

const CONFIG = {
  operator_roles: {
    owner: 32,
    estimator: 35, // Omar — unverified in the roster
    hr: 34,
    office: 31,
  },
}

describe('routeAttention — mapping table rows', () => {
  it('routes a routine receivable to the office (Lamar)', () => {
    const result = routeAttention({ subjectType: 'receivable', priority: 'awareness' }, ROSTER, CONFIG)
    expect(result).toEqual({ operatorId: 31, reason: 'Receivable — Lamar chases and logs it.' })
  })

  it('escalates a critical receivable to the owner (Wallace)', () => {
    const result = routeAttention({ subjectType: 'receivable', priority: 'critical' }, ROSTER, CONFIG)
    expect(result).toEqual({
      operatorId: 32,
      reason: 'Receivable at critical priority — money at risk is Wallace’s call.',
    })
  })

  it('routes construction_change/estimate to the estimator role — unrouted because Omar is unverified', () => {
    const result = routeAttention(
      { subjectType: 'construction_change', entityType: 'estimate', priority: 'decision' },
      ROSTER,
      CONFIG
    )
    expect(result).toEqual({
      unrouted: true,
      reason: "Omar is mapped to role 'estimator' but is not verified — an unverified operator never receives attention.",
    })
  })

  it('routes construction_change/estimate to the estimator role when verified', () => {
    const verifiedOmar = { ...OMAR, verified: true }
    const result = routeAttention(
      { subjectType: 'construction_change', entityType: 'estimate', priority: 'decision' },
      [WALLACE, JAY, verifiedOmar, LAMAR],
      CONFIG
    )
    expect(result).toEqual({ operatorId: 35, reason: 'Estimate — Omar owns pricing.' })
  })

  it('routes construction_change/pay_period to HR (Jay)', () => {
    const result = routeAttention(
      { subjectType: 'construction_change', entityType: 'pay_period', priority: 'routine' },
      ROSTER,
      CONFIG
    )
    expect(result).toEqual({ operatorId: 34, reason: 'Payroll — Jay handles crew.' })
  })

  it('routes a normal-priority purchase order to the office (Lamar) — non-escalating case', () => {
    const result = routeAttention(
      { subjectType: 'construction_change', entityType: 'purchase_order', priority: 'awareness' },
      ROSTER,
      CONFIG
    )
    expect(result).toEqual({ operatorId: 31, reason: 'Purchase order — Lamar tracks the vendor paperwork.' })
  })

  it('escalates a decision-priority purchase order to the owner (Wallace)', () => {
    const result = routeAttention(
      { subjectType: 'construction_change', entityType: 'purchase_order', priority: 'decision' },
      ROSTER,
      CONFIG
    )
    expect(result).toEqual({
      operatorId: 32,
      reason: 'Purchase order flagged decision/critical — vendors and money are Wallace’s call.',
    })
  })

  it('escalates a critical-priority purchase order to the owner (Wallace) too', () => {
    const result = routeAttention(
      { subjectType: 'construction_change', entityType: 'purchase_order', priority: 'critical' },
      ROSTER,
      CONFIG
    )
    expect(result).toEqual({
      operatorId: 32,
      reason: 'Purchase order flagged decision/critical — vendors and money are Wallace’s call.',
    })
  })

  it('routes construction_change/project to the office (Lamar)', () => {
    const result = routeAttention(
      { subjectType: 'construction_change', entityType: 'project', priority: 'awareness' },
      ROSTER,
      CONFIG
    )
    expect(result).toEqual({ operatorId: 31, reason: 'Project update — Lamar keeps the paper trail current.' })
  })

  it('routes construction_change/receipt to the office (Lamar)', () => {
    const result = routeAttention(
      { subjectType: 'construction_change', entityType: 'receipt', priority: 'routine' },
      ROSTER,
      CONFIG
    )
    expect(result).toEqual({ operatorId: 31, reason: 'Receipt — Lamar files it.' })
  })

  it('routes freight_request to the office (Lamar) — document filing is his job by role', () => {
    const result = routeAttention({ subjectType: 'freight_request' }, ROSTER, CONFIG)
    expect(result).toEqual({ operatorId: 31, reason: 'Freight document request — Lamar files it.' })
  })
})

describe('routeAttention — unmapped and misconfigured cases', () => {
  it('returns unrouted for an unmapped subject type, never silently defaulting to the owner', () => {
    const result = routeAttention({ subjectType: 'conversation' }, ROSTER, CONFIG)
    expect(result).toEqual({
      unrouted: true,
      reason: "No routing rule for subject type 'conversation'.",
    })
  })

  it('returns unrouted for an unmapped construction_change entity type', () => {
    const result = routeAttention(
      { subjectType: 'construction_change', entityType: 'invoice' },
      ROSTER,
      CONFIG
    )
    expect(result).toEqual({
      unrouted: true,
      reason: "No routing rule for subject type 'construction_change:invoice'.",
    })
  })

  it('returns unrouted with a naming reason when the mapped operator is unverified (Omar/estimator)', () => {
    const result = routeAttention(
      { subjectType: 'construction_change', entityType: 'estimate' },
      ROSTER,
      CONFIG
    )
    expect(result).toEqual({
      unrouted: true,
      reason: "Omar is mapped to role 'estimator' but is not verified — an unverified operator never receives attention.",
    })
  })

  it('returns unrouted when a role has no workspace mapping at all', () => {
    const result = routeAttention({ subjectType: 'freight_request' }, ROSTER, {})
    expect(result).toEqual({
      unrouted: true,
      reason:
        "No operator is mapped to role 'office' (Freight document request — office files it.) — configure operator_roles.office for this workspace.",
    })
  })

  it('returns unrouted when config is entirely absent, never falling back to any operator', () => {
    const result = routeAttention({ subjectType: 'receivable', priority: 'critical' }, ROSTER, null)
    expect(result).toEqual({
      unrouted: true,
      reason:
        "No operator is mapped to role 'owner' (Receivable at critical priority — money at risk is owner’s call.) — configure operator_roles.owner for this workspace.",
    })
  })

  it('returns unrouted when the role resolves to an operator id absent from the roster', () => {
    const result = routeAttention(
      { subjectType: 'freight_request' },
      ROSTER,
      { operator_roles: { office: 999 } }
    )
    expect(result).toEqual({
      unrouted: true,
      reason: "Operator 999 is mapped to role 'office' but is not on the operator roster.",
    })
  })
})

describe('resolveRoleOperatorId — provenance', () => {
  it('reports the shipped default (unset, null) when no workspace config is present', () => {
    expect(resolveRoleOperatorId(null, 'office')).toEqual({ value: null, source: 'default' })
    expect(resolveRoleOperatorId({}, 'office')).toEqual({ value: null, source: 'default' })
  })

  it('a workspace override beats the shipped default', () => {
    expect(resolveRoleOperatorId(CONFIG, 'office')).toEqual({ value: 31, source: 'workspace' })
    expect(resolveRoleOperatorId(CONFIG, 'estimator')).toEqual({ value: 35, source: 'workspace' })
  })

  it('accepts a numeric-string operator id from config the same way bedrockIdentityFor does', () => {
    expect(resolveRoleOperatorId({ operator_roles: { hr: '34' } }, 'hr')).toEqual({
      value: 34,
      source: 'workspace',
    })
  })
})
