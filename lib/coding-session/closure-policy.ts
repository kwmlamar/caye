export const TRUSTED_CODING_REPOSITORY = 'kwmlamar/caye'
export const CODING_BASE_BRANCH = 'main'
export const SOFTWARE_LEARNING_MIN_EVIDENCE = 2

export type EngineeringVerdict =
  | 'branch_verified'
  | 'inconclusive'
  | 'failed'
  | 'production_verified'

export type PredictionComparison = 'confirmed' | 'contradicted' | 'inconclusive'
export type EngineeringEvidenceSource = 'simulated' | 'branch' | 'test' | 'production'

export interface EngineeringClosureInput {
  repository: string
  baseBranch: string
  workBranch: string
  testPassed: boolean | null
  buildPassed: boolean | null
  branchPushPassed: boolean
  productionObserved: boolean
  productionHealthy?: boolean | null
  productionEvidenceSource?: EngineeringEvidenceSource | null
}

export interface EngineeringClosure {
  verdict: EngineeringVerdict
  comparison: PredictionComparison
  environment: 'branch' | 'production'
  productionVerified: boolean
  summary: string
  evidenceSources: EngineeringEvidenceSource[]
}

export interface SoftwareLearningEvidenceInput {
  workspaceId: string | null
  learningKey: string | null
  verdict: EngineeringVerdict | null
  environment: 'branch' | 'production' | null
  productionEvidenceSource: EngineeringEvidenceSource | null
  hasExecutionEvidence: boolean
  hasObservedOutcome: boolean
  matchingIndependentProductionOutcomes: number
}

export interface SoftwareLearningEvidenceAssessment {
  candidate: boolean
  reusable: boolean
  minimumEvidenceThreshold: number
  reason: string
}

function branchEvidenceSources(input: EngineeringClosureInput): EngineeringEvidenceSource[] {
  const sources: EngineeringEvidenceSource[] = ['branch']
  if (input.testPassed !== null || input.buildPassed !== null) sources.push('test')
  return sources
}

/**
 * Converts observed engineering evidence into an honest verdict.
 * A patch, simulation, local test, build, or review-branch push can never become
 * a production-success claim. Production verification requires a separately
 * authorized deployment plus an independently observed production signal.
 */
export function evaluateEngineeringClosure(input: EngineeringClosureInput): EngineeringClosure {
  const evidenceSources = branchEvidenceSources(input)

  if (input.repository !== TRUSTED_CODING_REPOSITORY) {
    return { verdict: 'failed', comparison: 'contradicted', environment: 'branch', productionVerified: false, evidenceSources, summary: `Repository identity mismatch: expected ${TRUSTED_CODING_REPOSITORY}.` }
  }

  if (!input.workBranch || input.workBranch === input.baseBranch || input.workBranch === CODING_BASE_BRANCH) {
    return { verdict: 'failed', comparison: 'contradicted', environment: 'branch', productionVerified: false, evidenceSources, summary: 'Engineering execution was not isolated from the protected base branch.' }
  }

  if (input.testPassed !== true || input.buildPassed !== true || !input.branchPushPassed) {
    return { verdict: input.testPassed === false || input.buildPassed === false ? 'failed' : 'inconclusive', comparison: input.testPassed === false || input.buildPassed === false ? 'contradicted' : 'inconclusive', environment: 'branch', productionVerified: false, evidenceSources, summary: 'The branch did not produce complete passing execution evidence.' }
  }

  if (!input.productionObserved) {
    return { verdict: 'branch_verified', comparison: 'confirmed', environment: 'branch', productionVerified: false, evidenceSources, summary: 'Prediction confirmed for the isolated review branch; production remains unverified and requires authorized merge/deploy plus observation.' }
  }

  if (input.productionEvidenceSource !== 'production') {
    return { verdict: 'inconclusive', comparison: 'inconclusive', environment: 'production', productionVerified: false, evidenceSources: input.productionEvidenceSource ? [...evidenceSources, input.productionEvidenceSource] : evidenceSources, summary: 'Production was claimed as observed, but no independent production evidence source was supplied.' }
  }

  const productionSources: EngineeringEvidenceSource[] = [...evidenceSources, 'production']
  if (input.productionHealthy === true) {
    return { verdict: 'production_verified', comparison: 'confirmed', environment: 'production', productionVerified: true, evidenceSources: productionSources, summary: 'Authorized production change was independently observed healthy after deployment.' }
  }

  return { verdict: input.productionHealthy === false ? 'failed' : 'inconclusive', comparison: input.productionHealthy === false ? 'contradicted' : 'inconclusive', environment: 'production', productionVerified: false, evidenceSources: productionSources, summary: input.productionHealthy === false ? 'Production observation contradicted the expected result; recovery or rollback is required.' : 'Production was observed, but the evidence is insufficient for a success verdict.' }
}

/**
 * Decides whether a software engineering outcome is strong enough to enter the
 * existing learning audit, and whether repeated evidence is sufficient to be
 * considered reusable. This does not write reusable memory itself.
 *
 * Workspace scope is deliberate: operator_learning_audit is workspace-scoped.
 * Founder/global coding sessions must not be mislabeled as a customer workspace
 * merely to manufacture learning evidence.
 */
export function assessSoftwareLearningEvidence(input: SoftwareLearningEvidenceInput): SoftwareLearningEvidenceAssessment {
  const base = { candidate: false, reusable: false, minimumEvidenceThreshold: SOFTWARE_LEARNING_MIN_EVIDENCE }

  if (!input.workspaceId) return { ...base, reason: 'Founder/global coding sessions are outside the workspace learning audit scope.' }
  if (!input.learningKey?.trim()) return { ...base, reason: 'A stable learning key is required before engineering evidence can be grouped.' }
  if (input.environment !== 'production' || input.productionEvidenceSource !== 'production') return { ...base, reason: 'Only independently observed production outcomes qualify as learning evidence.' }
  if (!input.hasExecutionEvidence || !input.hasObservedOutcome) return { ...base, reason: 'Both implementation evidence and an observed outcome are required.' }
  if (input.verdict === null || input.verdict === 'branch_verified' || input.verdict === 'inconclusive') return { ...base, reason: 'Only conclusive production outcomes become learning candidates.' }

  const reusable = input.matchingIndependentProductionOutcomes >= SOFTWARE_LEARNING_MIN_EVIDENCE
  return {
    candidate: true,
    reusable,
    minimumEvidenceThreshold: SOFTWARE_LEARNING_MIN_EVIDENCE,
    reason: reusable
      ? `Repeated evidence threshold satisfied by ${input.matchingIndependentProductionOutcomes} independent matching production outcomes.`
      : `Evidence-backed outcome is a candidate only; reusable learning requires at least ${SOFTWARE_LEARNING_MIN_EVIDENCE} independent matching production outcomes.`,
  }
}

export function codingSessionBranch(sessionId: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) throw new Error('Invalid coding session id')
  return `caye/coding-session/${sessionId}`
}
