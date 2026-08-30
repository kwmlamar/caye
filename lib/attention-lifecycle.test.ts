import { describe, expect, it } from 'vitest'
import { attentionPriorityScore, decideAttentionLifecycle, shouldReopen } from './attention-lifecycle'
import { attentionSubjectLabel, hasInternalIdentifierLeak, presentAttentionOutcome } from './attention-presentation'

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
  it('suppresses duplicate/unchanged event after notification', () => {
    expect(decideAttentionLifecycle({ ...base, notifiedFingerprint: 'state-a' })).toBe('SUPPRESS_UNCHANGED')
  })

  it('reopens/resurfaces a changed blocker', () => {
    expect(shouldReopen('state-a', 'state-b')).toBe(true)
    expect(decideAttentionLifecycle({ ...base, stateFingerprint: 'state-b', notifiedFingerprint: 'state-a' })).toBe('NOTIFY')
  })

  it('does not convert delivery into operator awareness', () => {
    expect(decideAttentionLifecycle({ ...base, notificationDelivered: true })).toBe('NOTIFY')
  })

  it('keeps acknowledged but unresolved work alive', () => {
    expect(decideAttentionLifecycle({ ...base, status: 'acknowledged', notifiedFingerprint: 'state-a' })).toBe('WAIT_FOR_DECISION')
  })

  it('keeps decided work alive until underlying work completes/resumes', () => {
    expect(decideAttentionLifecycle({ ...base, status: 'decided', notifiedFingerprint: 'state-a' })).toBe('WAIT_FOR_DECISION')
  })

  it('retires completed underlying work', () => {
    expect(decideAttentionLifecycle({ ...base, underlyingCompleted: true })).toBe('RETIRE_COMPLETED')
  })

  it('does not resurrect stale resolved items without material change', () => {
    expect(shouldReopen('same', 'same')).toBe(false)
    expect(decideAttentionLifecycle({ ...base, status: 'resolved' })).toBe('NO_ACTION')
  })

  it('suppresses notification already in flight, including delivery failure retry windows', () => {
    expect(decideAttentionLifecycle({ ...base, pendingNotification: true })).toBe('SUPPRESS_IN_FLIGHT')
  })

  it('ranks authority/deadline/customer impact ahead of reversible autonomous work', () => {
    const ownerDecision = attentionPriorityScore({ severity: 3, urgency: 3, reversibility: 0, authorityNeed: 3, deadline: 3, customerImpact: 3, autonomouslyResolvable: false })
    const autonomous = attentionPriorityScore({ severity: 2, urgency: 2, reversibility: 3, authorityNeed: 0, deadline: 0, customerImpact: 1, autonomouslyResolvable: true })
    expect(ownerDecision).toBeGreaterThan(autonomous)
  })
})

describe('human presentation', () => {
  it('never leaks internal UUIDs', () => {
    const text = presentAttentionOutcome({ subjectType: 'conversation', title: '23409c9e-a5a3-41bb-b9c5-cb81a79b8114', customerName: 'Kelsey Tonner', action: 'Removed from the held queue' })
    expect(text).toBe("Removed from the held queue Kelsey Tonner.")
    expect(hasInternalIdentifierLeak(text)).toBe(false)
  })

  it('keeps two same-name customers distinguishable when a stable human identity is supplied', () => {
    expect(attentionSubjectLabel({ subjectType: 'conversation', customerName: 'Alex Smith', customerEmail: 'alex.one@example.com', serviceName: 'private tour' })).toBe("Alex Smith's private tour")
    expect(attentionSubjectLabel({ subjectType: 'conversation', customerName: 'Alex Smith', customerEmail: 'alex.two@example.com', serviceName: 'airport transfer' })).toBe("Alex Smith's airport transfer")
  })

  it('never uses workspace or subject ids as display fallback, preventing cross-workspace collision leakage', () => {
    const a = attentionSubjectLabel({ subjectType: 'conversation', title: '23409c9e-a5a3-41bb-b9c5-cb81a79b8114' })
    const b = attentionSubjectLabel({ subjectType: 'conversation', title: '33409c9e-a5a3-41bb-b9c5-cb81a79b8114' })
    expect(a).toBe('customer conversation')
    expect(b).toBe('customer conversation')
  })
})
