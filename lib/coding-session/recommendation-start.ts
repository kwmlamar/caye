import 'server-only'

type CanonicalRecommendationRow = {
  title: string
  recommendation: string
  rationale: string
}

/**
 * Formatting helper retained only for audit/tests and future migration work.
 * The returned prose is NOT an executable coding-session contract.
 */
export function deriveCanonicalCodingTask(
  row: Pick<CanonicalRecommendationRow, 'title' | 'recommendation' | 'rationale'>,
): string {
  return [
    `Implement canonical recommendation: ${row.title.trim()}`,
    `Required change: ${row.recommendation.trim()}`,
    `Grounding: ${row.rationale.trim()}`,
    'Keep the change bounded. Preserve existing authority, security, payment, migration, messaging, and approval boundaries. Do not merge or deploy.',
  ].join('\n\n')
}

/**
 * Fail-closed kill switch for recommendation -> coding execution.
 *
 * A canonical recommendation is still natural-language intent. Acceptance and
 * generic recommendation execution eligibility do not make that prose a safe
 * coding-agent program. Re-enable this bridge only after self-improvement has:
 *
 * - a code-owned structured coding intent/classification before sandbox launch;
 * - an immutable root/parent lineage and bounded recursion depth; and
 * - founder-required handling for protected/self-protection changes before the
 *   coding model receives executable instructions.
 */
export async function startCodingSessionForRecommendation(input: {
  recommendationId: string
  workspaceId: string | null
}): Promise<{ sessionId: string }> {
  void input
  throw new Error(
    'Recommendation-triggered coding is disabled until structured coding intent and bounded recursion controls are enforced',
  )
}
