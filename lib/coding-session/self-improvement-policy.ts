export type SelfImprovementRiskClass = 'test_only' | 'founder_required' | 'unsupported'

export type SelfImprovementClassification = {
  riskClass: SelfImprovementRiskClass
  autonomouslyEligible: boolean
  founderRequired: boolean
  protectedArea: boolean
  reasons: string[]
}

const TEST_FILE_PATTERNS = [
  /(^|\/)tests\//,
  /(^|\/)test\//,
  /(^|\/)__tests__\//,
  /\.(test|spec)\.(ts|tsx|js|jsx)$/,
]

// This list is intentionally code-owned. Model output is evidence, never permission.
const PROTECTED_PATH_PATTERNS = [
  /(^|\/)(auth|authentication|security|secrets?)(\/|\.|$)/i,
  /(^|\/)(payments?|billing|stripe)(\/|\.|$)/i,
  /(^|\/)supabase\/migrations\//i,
  /(^|\/)(rls|row-level-security)(\/|\.|$)/i,
  /(^|\/)(decision-authority|action-autonomy)(\/|\.|$)/i,
  /(^|\/)recommendations?\/(decisions?|.*authority.*|.*policy.*)(\.|\/|$)/i,
  /(^|\/)(external-messaging|customer-communication|outreach)(\/|\.|$)/i,
  /(^|\/)(self-improvement-policy|self-improvement-risk)(\.|\/|$)/i,
  /(^|\/)(approval-bypass|branch-protection|security-boundar)(.*)$/i,
  /(^|\/)lib\/coding-session\/(self-improvement-policy|recommendation-start)(\.|\/|$)/i,
]

export function isRecognizedTestFile(path: string): boolean {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '')
  return TEST_FILE_PATTERNS.some((pattern) => pattern.test(normalized))
}

export function isProtectedSelfImprovementPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '')
  return PROTECTED_PATH_PATTERNS.some((pattern) => pattern.test(normalized))
}

export function classifySelfImprovementChange(input: {
  changedPaths: string[]
  modelRisk?: string | null
  modelCategory?: string | null
}): SelfImprovementClassification {
  const paths = [...new Set(input.changedPaths.map((path) => path.trim()).filter(Boolean))]
  if (!paths.length) {
    return { riskClass: 'unsupported', autonomouslyEligible: false, founderRequired: false, protectedArea: false, reasons: ['no_changed_paths'] }
  }

  const protectedPaths = paths.filter(isProtectedSelfImprovementPath)
  if (protectedPaths.length) {
    return {
      riskClass: 'founder_required', autonomouslyEligible: false, founderRequired: true, protectedArea: true,
      reasons: protectedPaths.map((path) => `protected_path:${path}`),
    }
  }

  const nonTests = paths.filter((path) => !isRecognizedTestFile(path))
  if (nonTests.length) {
    return {
      riskClass: 'unsupported', autonomouslyEligible: false, founderRequired: false, protectedArea: false,
      reasons: nonTests.map((path) => `non_test_path:${path}`),
    }
  }

  return { riskClass: 'test_only', autonomouslyEligible: true, founderRequired: false, protectedArea: false, reasons: ['all_paths_are_unprotected_tests'] }
}

export function autonomousMergeAllowedForSelfImprovement(): false {
  // No pre-existing policy grants autonomous merge for test_only in v1.
  return false
}
