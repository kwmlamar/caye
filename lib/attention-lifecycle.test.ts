import { describe, expect, it } from 'vitest'
import { attentionPriorityScore, decideAttentionLifecycle, shouldReopen } from './attention-lifecycle'
import { attentionSubjectLabel, hasInternalIdentifierLeak, humanizeLegacyAttentionText, presentAttentionOutcome } from './attention-presentation'
import { detectInternalLeak } from './operator-text-guard'

const base = {
  status: 'open' as const,
  stateFingerprint: 'state-a',
  notifiedFingerprint: null,
  operatorAwareFingerprint: null,
  blockedOnOperator: true,
  resolvableAutonomously: false,
  pendingNotification: false,
  notificationDelivered: false,
  underlyingCompleted: false,
}

describe('canonical attention lifecycle', () => {
  it('suppresses duplicate and unchanged state after notification', () => {
    expect(decideAttentionLifecycle({ ...base, notifiedFingerprint: 'state-a' })).toBe('SUPPRESS_UNCHANGED')
  })
  it('reopens only on material state change', () => {
    expect(shouldReopen('state-a', 'state-b')).toBe(true)
    expect(shouldReopen('state-a', 'state-a')).toBe(false)
    expect(decideAttentionLifecycle({ ...base, stateFingerprint: 'state-b', notifiedFingerprint: 'state-a' })).toBe('NOTIFY')
  })
  it('delivery is not operator awareness', () => {
    expect(decideAttentionLifecycle({ ...base, notificationDelivered: true })).toBe('NOTIFY')
  })
  it('independent awareness suppresses the unchanged state', () => {
    expect(decideAttentionLifecycle({ ...base, operatorAwareFingerprint: 'state-a' })).toBe('SUPPRESS_OPERATOR_AWARE')
  })
  it('acknowledged but unresolved and decided but unfinished remain live', () => {
    expect(decideAttentionLifecycle({ ...base, status: 'acknowledged', notifiedFingerprint: 'state-a' })).toBe('WAIT_FOR_DECISION')
    expect(decideAttentionLifecycle({ ...base, status: 'decided', notifiedFingerprint: 'state-a' })).toBe('WAIT_FOR_DECISION')
  })
  it('retires completed underlying work and stale resolved work stays retired', () => {
    expect(decideAttentionLifecycle({ ...base, underlyingCompleted: true })).toBe('RETIRE_COMPLETED')
    expect(decideAttentionLifecycle({ ...base, status: 'resolved' })).toBe('NO_ACTION')
  })
  it('suppresses a genuinely in-flight notification', () => {
    expect(decideAttentionLifecycle({ ...base, pendingNotification: true })).toBe('SUPPRESS_IN_FLIGHT')
  })
  it('lets Caye finish reversible autonomous work instead of bothering a person', () => {
    expect(decideAttentionLifecycle({ ...base, blockedOnOperator: false, resolvableAutonomously: true })).toBe('RESOLVE_AUTONOMOUS')
  })
  it('prioritizes authority, deadline and customer impact', () => {
    const decision = attentionPriorityScore({ severity: 3, urgency: 3, reversibility: 0, authorityNeed: 3, deadline: 3, customerImpact: 3, autonomouslyResolvable: false })
    const autonomous = attentionPriorityScore({ severity: 2, urgency: 2, reversibility: 3, authorityNeed: 0, deadline: 0, customerImpact: 1, autonomouslyResolvable: true })
    expect(decision).toBeGreaterThan(autonomous)
  })
})

describe('human-facing attention abstraction', () => {
  const leakedId = '23409c9e-a5a3-41bb-b9c5-cb81a79b8114'
  it('renders the production Kelsey case without the internal id', () => {
    const text = presentAttentionOutcome({ subjectType: 'conversation', title: leakedId, customerName: 'Kelsey Tonner', serviceName: 'marketing email', action: 'Removed from the held queue' })
    expect(text).toBe("Removed from the held queue Kelsey Tonner's marketing email.")
    expect(hasInternalIdentifierLeak(text)).toBe(false)
  })
  it('repairs the exact historical legacy leak at render time', () => {
    const text = humanizeLegacyAttentionText(`Skipped held thread ${leakedId}`)
    expect(text).toBe('Removed the held customer conversation from the queue.')
    expect(text).not.toContain(leakedId)
  })
  it('blocks raw UUIDs at the operator-text safety boundary', () => {
    expect(detectInternalLeak(`Skipped held thread ${leakedId}`)).toContain('raw internal identifier')
  })
  it('disambiguates two customers with the same name and same service without database ids', () => {
    const a = attentionSubjectLabel({ subjectType: 'conversation', customerName: 'Alex Smith', serviceName: 'private tour', disambiguator: 'alex.one@example.com' })
    const b = attentionSubjectLabel({ subjectType: 'conversation', customerName: 'Alex Smith', serviceName: 'private tour', disambiguator: 'alex.two@example.com' })
    expect(a).not.toBe(b)
    expect(a).not.toMatch(/[0-9a-f]{8}-[0-9a-f-]{27,}/i)
    expect(b).not.toMatch(/[0-9a-f]{8}-[0-9a-f-]{27,}/i)
  })
  it('uses semantic fallback across workspaces rather than leaking workspace/subject ids', () => {
    expect(attentionSubjectLabel({ subjectType: 'conversation', title: leakedId })).toBe('customer conversation')
    expect(attentionSubjectLabel({ subjectType: 'conversation', title: '33409c9e-a5a3-41bb-b9c5-cb81a79b8114' })).toBe('customer conversation')
  })
})
