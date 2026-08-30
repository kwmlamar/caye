export const TRUSTED_CODING_REPOSITORY = 'kwmlamar/caye'
export const CODING_BASE_BRANCH = 'main'

export type EngineeringVerdict =
  | 'branch_verified'
  | 'inconclusive'
  | 'failed'
  | 'production_verified'

export type PredictionComparison = 'confirmed' | 'contradicted' | 'inconclusive'

export interface EngineeringClosureInput {
  repository: string
  baseBranch: string
  workBranch: string
  testPassed: boolean | null
  buildPassed: boolean | null
  branchPushPassed: boolean
  productionObserved: boolean
  productionHealthy?: boolean | null
}

export interface EngineeringClosure {
  verdict: EngineeringVerdict
  comparison: PredictionComparison
  environment: 'branch' | 'production'
  productionVerified: boolean
  summary: string
}

/**
 * Converts observed engineering evidence into an honest verdict.
 * A patch, local test, build, or review-branch push can never become a
 * production-success claim. Production verification requires a separate
 * production observation after an authorized merge/deploy.
 */
export function evaluateEngineeringClosure(input: EngineeringClosureInput): EngineeringClosure {
  if (input.repository !== TRUSTED_CODING_REPOSITORY) {
    return {
      verdict: 'failed',
      comparison: 'contradicted',
      environment: 'branch',
      productionVerified: false,
      summary: `Repository identity mismatch: expected ${TRUSTED_CODING_REPOSITORY}.`,
    }
  }

  if (!input.workBranch || input.workBranch === input.baseBranch || input.workBranch === CODING_BASE_BRANCH) {
    return {
      verdict: 'failed',
      comparison: 'contradicted',
      environment: 'branch',
      productionVerified: false,
      summary: 'Engineering execution was not isolated from the protected base branch.',
    }
  }

  if (input.testPassed !== true || input.buildPassed !== true || !input.branchPushPassed) {
    return {
      verdict: input.testPassed === false || input.buildPassed === false ? 'failed' : 'inconclusive',
      comparison: input.testPassed === false || input.buildPassed === false ? 'contradicted' : 'inconclusive',
      environment: 'branch',
      productionVerified: false,
      summary: 'The branch did not produce complete passing execution evidence.',
    }
  }

  if (!input.productionObserved) {
    return {
      verdict: 'branch_verified',
      comparison: 'confirmed',
      environment: 'branch',
      productionVerified: false,
      summary: 'Prediction confirmed for the isolated review branch; production remains unverified and requires authorized merge/deploy plus observation.',
    }
  }

  if (input.productionHealthy === true) {
    return {
      verdict: 'production_verified',
      comparison: 'confirmed',
      environment: 'production',
      productionVerified: true,
      summary: 'Authorized production change was observed healthy after deployment.',
    }
  }

  return {
    verdict: input.productionHealthy === false ? 'failed' : 'inconclusive',
    comparison: input.productionHealthy === false ? 'contradicted' : 'inconclusive',
    environment: 'production',
    productionVerified: false,
    summary: input.productionHealthy === false
      ? 'Production observation contradicted the expected result; recovery or rollback is required.'
      : 'Production was observed, but the evidence is insufficient for a success verdict.',
  }
}

export function codingSessionBranch(sessionId: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) throw new Error('Invalid coding session id')
  return `caye/coding-session/${sessionId}`
}
