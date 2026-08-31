import 'server-only'

import type { IntelligenceScope } from './identity'
import { ingestIntelligenceFinding } from './ingest'
import {
  opportunityFingerprint,
  scoreOpportunity,
  validateOpportunity,
  type CareerOpportunity,
} from './career-opportunity-desk'

export type PersistCareerOpportunityInput = {
  scope: IntelligenceScope
  opportunity: CareerOpportunity
  evidenceClaimIds: string[]
}

/**
 * Projects a Career & Economic Opportunity desk result into the canonical
 * Caye Intelligence substrate. Research claims remain the evidence authority;
 * the opportunity is persisted as a recommendation above those claims.
 */
export async function persistCareerOpportunity(input: PersistCareerOpportunityInput) {
  validateOpportunity(input.opportunity)

  const evidenceClaimIds = [...new Set(input.evidenceClaimIds.map((id) => id.trim()).filter(Boolean))]
  if (evidenceClaimIds.length === 0) {
    throw new Error('career opportunities require canonical research claim evidence before persistence')
  }

  const opportunity = input.opportunity
  const fingerprint = opportunity.fingerprint ?? opportunityFingerprint(opportunity)
  const rankingScore = scoreOpportunity(opportunity.scores) / 100

  return ingestIntelligenceFinding({
    scope: input.scope,
    domain: 'career_economic_opportunity',
    topic: opportunity.category,
    claim: `Opportunity: ${opportunity.title}. ${opportunity.description} Recommended next step: ${opportunity.recommendedNextStep}`,
    epistemicType: 'recommendation',
    relevance: rankingScore,
    materiality: opportunity.scores.expectedIncome / 100,
    novelty: opportunity.scores.longTermOptionality / 100,
    observedAt: opportunity.discoveredAt,
    validFrom: opportunity.discoveredAt,
    validUntil: opportunity.expiresAt ?? opportunity.deadline ?? null,
    evidence: evidenceClaimIds.map((claimId) => ({ claimId, role: 'supports' as const })),
    provenance: {
      source: 'career_economic_opportunity_desk',
      opportunityFingerprint: fingerprint,
      opportunity: {
        ...opportunity,
        fingerprint,
        rankingScore,
      },
      legalBoundary: {
        immigrationLegalDeterminationMade: false,
        workAuthorizationConstraintsRequireAuthoritativeVerification: true,
      },
    },
  })
}
