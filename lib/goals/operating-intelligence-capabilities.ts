export const OPERATING_INTELLIGENCE_CAPABILITIES = [
  { key: 'perception_awareness', title: 'Perception & Continuous Awareness' },
  { key: 'memory_context', title: 'Memory & Context' },
  { key: 'research_intelligence', title: 'Research & Intelligence' },
  { key: 'reasoning_simulation', title: 'Reasoning & Simulation' },
  { key: 'planning_anticipation', title: 'Planning & Anticipation' },
  { key: 'execution_autonomy', title: 'Execution & Autonomy' },
  { key: 'monitoring_control', title: 'Monitoring & Control' },
  { key: 'engineering_copilot', title: 'Engineering Copilot' },
  { key: 'environment_machine_interface', title: 'Environment & Machine Interface' },
  { key: 'adaptive_learning', title: 'Adaptive Learning' },
  { key: 'proactive_operator', title: 'Proactive Operator' },
  { key: 'human_command_interface', title: 'Human Command Interface' },
] as const

export type OperatingIntelligenceCapabilityKey = typeof OPERATING_INTELLIGENCE_CAPABILITIES[number]['key']
export type CapabilityMaturityStatus = 'unverified' | 'foundation' | 'limited' | 'active' | 'future'

export interface CapabilityProgressClaim {
  progressPercent: number | null
  progressEvidenceId: number | null
  lastVerifiedAt: string | null
}

/**
 * Numeric progress is displayable only when it is tied to verified evidence
 * and a verification time. Null progress is always valid and preferred over a
 * fabricated estimate.
 */
export function hasDefensibleCapabilityProgress(claim: CapabilityProgressClaim): boolean {
  if (claim.progressPercent === null) {
    return claim.progressEvidenceId === null
  }
  return claim.progressPercent >= 0
    && claim.progressPercent <= 100
    && claim.progressEvidenceId !== null
    && claim.lastVerifiedAt !== null
}
