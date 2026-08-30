import { describe, expect, it } from 'vitest'
import { evaluateInterruption, interruptionFingerprint, type InterruptionPolicyInput } from './interruption-policy'

const base: InterruptionPolicyInput = {
  workspaceId: 'ws-a',
  subjectType: 'conversation',
  subjectId: 'conv-1',
  urgency: 'medium',
  importance: 'high',
  confidence: 'high',
  changeKind: 'new',
  awareness: 'unseen',
  blockedOnOperator: true,
  resolvableAutonomously: false,
  authorityAllowsAutonomousAction: false,
  cooldownActive: false,
  interruptionBudgetExhausted: false,
}

describe('interruptionFingerprint', () => {
  it('is deterministic and workspace scoped', () => {
    const a = interruptionFingerprint({ workspaceId: 'ws-a', subjectType: 'conversation', subjectId: '1', meaningfulState: ['pending', 10] })
    const again = interruptionFingerprint({ workspaceId: 'ws-a', subjectType: 'conversation', subjectId: '1', meaningfulState: ['pending', 10] })
    const otherWorkspace = interruptionFingerprint({ workspaceId: 'ws-b', subjectType: 'conversation', subjectId: '1', meaningfulState: ['pending', 10] })
    expect(a).toBe(again)
    expect(otherWorkspace).not.toBe(a)
  })

  it('changes only when supplied meaningful state changes', () => {
    const pending = interruptionFingerprint({ workspaceId: 'ws-a', subjectType: 'booking', subjectId: 'b1', meaningfulState: ['pending'] })
    const confirmed = interruptionFingerprint({ workspaceId: 'ws-a', subjectType: 'booking', subjectId: 'b1', meaningfulState: ['confirmed'] })
    expect(confirmed).not.toBe(pending)
  })
})

describe('evaluateInterruption', () => {
  it('surfaces a genuinely new meaningful issue', () => {
    expect(evaluateInterruption(base).action).toBe('SURFACE_NOW')
  })

  it('keeps an important unchanged surfaced item eligible for slow reminder cadence', () => {
    const decision = evaluateInterruption({ ...base, changeKind: 'unchanged', awareness: 'surfaced' })
    expect(decision.action).toBe('SURFACE_NOW')
    expect(decision.reasonCodes).toContain('paced_reminder_eligible')
  })

  it('suppresses unchanged ordinary awareness already surfaced', () => {
    const decision = evaluateInterruption({
      ...base,
      urgency: 'medium',
      importance: 'medium',
      changeKind: 'unchanged',
      awareness: 'surfaced',
    })
    expect(decision.action).toBe('SUPPRESS_UNCHANGED')
  })

  it('represents an undirected material change without inventing improvement or worsening', () => {
    const decision = evaluateInterruption({ ...base, changeKind: 'changed' })
    expect(decision.action).toBe('SURFACE_NOW')
    expect(decision.reasonCodes).toContain('changed')
  })

  it('allows material worsening to bypass ordinary cooldown', () => {
    const decision = evaluateInterruption({ ...base, changeKind: 'worsened', cooldownActive: true })
    expect(decision.action).toBe('SURFACE_NOW')
    expect(decision.bypassCooldown).toBe(true)
    expect(decision.reasonCodes).toContain('material_worsening')
  })

  it('closes resolved state without another interruption', () => {
    expect(evaluateInterruption({ ...base, changeKind: 'resolved' }).action).toBe('RESOLVE_SILENTLY')
  })

  it('keeps low-confidence low-consequence noise quiet', () => {
    const decision = evaluateInterruption({
      ...base,
      confidence: 'low',
      urgency: 'low',
      importance: 'low',
      consequencesOfWaiting: 'low',
    })
    expect(decision.action).toBe('WATCH')
    expect(decision.reasonCodes).toContain('avoid_unverified_claim')
  })

  it('asks for more evidence when confidence is weak but waiting could matter', () => {
    expect(evaluateInterruption({ ...base, confidence: 'low', consequencesOfWaiting: 'high' }).action).toBe('GATHER_EVIDENCE')
  })

  it('groups important issues when the ordinary interruption budget is exhausted', () => {
    expect(evaluateInterruption({ ...base, interruptionBudgetExhausted: true }).action).toBe('SURFACE_GROUPED')
  })

  it('lets a verified urgent/high-impact issue bypass cooldown and budget', () => {
    const decision = evaluateInterruption({
      ...base,
      urgency: 'critical',
      importance: 'critical',
      confidence: 'verified',
      cooldownActive: true,
      interruptionBudgetExhausted: true,
    })
    expect(decision.action).toBe('SURFACE_NOW')
    expect(decision.bypassCooldown).toBe(true)
    expect(decision.bypassBudget).toBe(true)
  })

  it('handles autonomously only when existing authority allows it', () => {
    const allowed = evaluateInterruption({
      ...base,
      blockedOnOperator: false,
      resolvableAutonomously: true,
      authorityAllowsAutonomousAction: true,
    })
    expect(allowed.action).toBe('HANDLE_AUTONOMOUSLY')

    const blocked = evaluateInterruption({
      ...base,
      blockedOnOperator: false,
      resolvableAutonomously: true,
      authorityAllowsAutonomousAction: false,
    })
    expect(blocked.action).toBe('SURFACE_NOW')
    expect(blocked.reasonCodes).toContain('authority_blocks_action')
  })

  it('does not re-interrupt an acknowledged unchanged issue', () => {
    expect(evaluateInterruption({ ...base, changeKind: 'unchanged', awareness: 'acknowledged' }).action).toBe('SUPPRESS_AWARE')
  })
})
