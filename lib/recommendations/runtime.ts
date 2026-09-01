import { createHash } from 'node:crypto'

import type {
  CreateGroundedRecommendationInput,
  RecommendationAuthority,
  RecommendationReversibility,
  RecommendationRisk,
  RecommendationUrgency,
} from './service'

export const RECOMMENDATION_CANDIDATE_LIMIT = 6
export const MATERIAL_RECOMMENDATION_THRESHOLD = 0.7
export const MATERIAL_BELIEF_DELTA = 0.15
export const HIGH_OBJECTIVE_IMPACT_CONFIDENCE = 0.75
export const CONTESTED_RECOMMENDATION_CONFIDENCE_CAP = 0.65

type TriggerKind =
  | 'material-belief-revision'
  | 'cross-domain-synthesis'
  | 'high-confidence-objective-impact'
  | 'contradiction-resolution'
  | 'material-constraint-or-opportunity'

export type RecommendationGoalSnapshot = {
  id: string
  title: string
  description: string | null
  status: string
  supersededAt: string | null
}

export type RecommendationIntelligenceSnapshot = {
  id: string
  domain: string
  claim: string
  status: string
  confidence: number | null
  materiality: number | null
  validUntil: string | null
  provenance: Record<string, unknown>
}

export type RecommendationGoalImpactSnapshot = {
  mechanism: string
  impact: string
  confidence: number
  evidenceClaimIds: string[]
  synthesisFingerprint: string
}

export type RecommendationBeliefRevisionSnapshot = {
  id: string
  priorConfidence: number | null
  revisedConfidence: number | null
  evidenceRole: string
  createdAt: string
}

export type RecommendationCandidate = {
  goal: RecommendationGoalSnapshot
  intelligence: RecommendationIntelligenceSnapshot
  goalImpact: RecommendationGoalImpactSnapshot
  beliefRevisions: RecommendationBeliefRevisionSnapshot[]
  hasCanonicalGoalImpact: boolean
}

export type RecommendationProposal = {
  title: string
  proposedAction: string
  rationale: string
  expectedOutcome: string
  expectedImpact: string
  urgency: RecommendationUrgency
  reversibility: RecommendationReversibility
  risk: RecommendationRisk
  confidence: number
  requiredAuthority: RecommendationAuthority
  supportingIntelligenceIds: string[]
  supportingClaimIds: string[]
  supportingBeliefRevisionIds?: string[]
}

export type RecommendationProposalContext = {
  trigger: TriggerKind
  triggerFingerprint: string
  goal: RecommendationGoalSnapshot
  intelligence: RecommendationIntelligenceSnapshot
  goalImpact: RecommendationGoalImpactSnapshot
  beliefRevisions: RecommendationBeliefRevisionSnapshot[]
}

export type RecommendationProposer = (
  context: RecommendationProposalContext,
) => Promise<RecommendationProposal | null>

export type RecommendationRuntimeStore = {
  loadCandidates: () => Promise<RecommendationCandidate[]>
  hasProposalFingerprint: (fingerprint: string) => Promise<boolean>
  persist: (input: CreateGroundedRecommendationInput) => Promise<unknown>
}

type TriggerDecision = {
  kind: TriggerKind
  rank: number
  materialRevisionIds: string[]
  contradictory: boolean
}

function numeric(value: unknown, fallback = 0): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function normalized(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

function connectionKind(candidate: RecommendationCandidate): string {
  const value = candidate.intelligence.provenance.connectionKind
  return typeof value === 'string' ? value : ''
}

function provenanceKind(candidate: RecommendationCandidate): string {
  const value = candidate.intelligence.provenance.kind
  return typeof value === 'string' ? value : ''
}

function hasProvenanceContradiction(candidate: RecommendationCandidate): boolean {
  const ids = candidate.intelligence.provenance.contradictoryEvidenceIds
  return Array.isArray(ids) && ids.length > 0
}

function materialRevisions(candidate: RecommendationCandidate): RecommendationBeliefRevisionSnapshot[] {
  return candidate.beliefRevisions.filter((revision) => {
    const delta = Math.abs(numeric(revision.revisedConfidence) - numeric(revision.priorConfidence))
    return delta >= MATERIAL_BELIEF_DELTA
      || ['contradicts', 'supersedes'].includes(revision.evidenceRole)
  })
}

export function classifyRecommendationTrigger(candidate: RecommendationCandidate): TriggerDecision | null {
  if (!candidate.hasCanonicalGoalImpact) return null
  if (candidate.goal.status !== 'active' || candidate.goal.supersededAt) return null
  if (!['current', 'contested'].includes(candidate.intelligence.status)) return null
  if (candidate.intelligence.validUntil && Date.parse(candidate.intelligence.validUntil) <= Date.now()) return null
  if (!normalized(candidate.goalImpact.mechanism) || !normalized(candidate.goalImpact.impact)) return null
  if (!candidate.goalImpact.evidenceClaimIds.length) return null

  const kind = connectionKind(candidate)
  // Weak-signal patterns are useful monitoring context, not a recommendation
  // trigger. They must first be promoted by stronger intelligence machinery.
  if (kind === 'weak-signal-pattern') return null

  const materiality = numeric(candidate.intelligence.materiality)
  const revisions = materialRevisions(candidate)
  const contradictory = candidate.intelligence.status === 'contested'
    || hasProvenanceContradiction(candidate)
    || revisions.some((revision) => ['contradicts', 'supersedes'].includes(revision.evidenceRole))

  if (revisions.some((revision) => ['contradicts', 'supersedes'].includes(revision.evidenceRole)) && materiality >= MATERIAL_RECOMMENDATION_THRESHOLD) {
    return { kind: 'contradiction-resolution', rank: 5, materialRevisionIds: revisions.map((revision) => revision.id), contradictory: true }
  }

  if (revisions.length && materiality >= MATERIAL_RECOMMENDATION_THRESHOLD) {
    return { kind: 'material-belief-revision', rank: 4, materialRevisionIds: revisions.map((revision) => revision.id), contradictory }
  }

  if (['constraint', 'opportunity'].includes(kind) && materiality >= MATERIAL_RECOMMENDATION_THRESHOLD) {
    return { kind: 'material-constraint-or-opportunity', rank: 4, materialRevisionIds: [], contradictory }
  }

  if (provenanceKind(candidate) === 'cross-domain-synthesis' && materiality >= 0.8) {
    return { kind: 'cross-domain-synthesis', rank: 3, materialRevisionIds: [], contradictory }
  }

  if (candidate.goalImpact.confidence >= HIGH_OBJECTIVE_IMPACT_CONFIDENCE
    && materiality >= MATERIAL_RECOMMENDATION_THRESHOLD) {
    return { kind: 'high-confidence-objective-impact', rank: 2, materialRevisionIds: [], contradictory }
  }

  return null
}

export function recommendationTriggerFingerprint(
  candidate: RecommendationCandidate,
  decision: TriggerDecision,
): string {
  return createHash('sha256').update(JSON.stringify({
    version: 'material-intelligence-recommendation-v1',
    goalId: candidate.goal.id,
    intelligenceItemId: candidate.intelligence.id,
    goalImpactFingerprint: candidate.goalImpact.synthesisFingerprint,
    mechanism: normalized(candidate.goalImpact.mechanism).toLowerCase(),
    impact: normalized(candidate.goalImpact.impact).toLowerCase(),
    revisionIds: [...decision.materialRevisionIds].sort(),
    trigger: decision.kind,
  })).digest('hex')
}

function specificAction(action: string): boolean {
  const text = normalized(action)
  if (text.length < 16 || text.length > 600 || text.split(' ').length < 4) return false
  return !/^(consider|monitor|explore|investigate|review|watch|think about)(\s+(this|it|further|closely))?\.?$/i.test(text)
}

function explicitText(value: string, minimum = 8): boolean {
  return normalized(value).length >= minimum
}

function validAuthority(authority: RecommendationAuthority): boolean {
  return Boolean(authority)
    && ['personal', 'workspace', 'business', 'unknown'].includes(authority.principalType)
    && ['canonical_authority', 'unresolved'].includes(authority.resolvedBy)
    && (authority.principalRef === null || typeof authority.principalRef === 'string')
}

export function validateRecommendationProposal(
  candidate: RecommendationCandidate,
  decision: TriggerDecision,
  proposal: RecommendationProposal,
): CreateGroundedRecommendationInput {
  if (!classifyRecommendationTrigger(candidate)) throw new Error('recommendation candidate is not materially eligible')
  if (!explicitText(proposal.title, 4)) throw new Error('recommendation title is required')
  if (!specificAction(proposal.proposedAction)) throw new Error('recommendation action is not specific enough to evaluate')
  if (!explicitText(proposal.rationale, 16)) throw new Error('recommendation rationale must state the intelligence-to-goal-to-action mechanism')
  if (!explicitText(proposal.expectedOutcome, 8) || !explicitText(proposal.expectedImpact, 8)) {
    throw new Error('recommendation expected outcome and impact are required')
  }
  if (!Number.isFinite(proposal.confidence) || proposal.confidence < 0 || proposal.confidence > 1) {
    throw new Error('recommendation confidence must be bounded')
  }
  if (!['low', 'medium', 'high', 'immediate'].includes(proposal.urgency)) throw new Error('recommendation urgency is invalid')
  if (!['easy', 'moderate', 'hard', 'irreversible'].includes(proposal.reversibility)) throw new Error('recommendation reversibility is invalid')
  if (!['low', 'medium', 'high', 'critical'].includes(proposal.risk)) throw new Error('recommendation risk is invalid')
  if (!validAuthority(proposal.requiredAuthority)) throw new Error('recommendation authority classification is invalid')

  const allowedIntelligence = new Set([candidate.intelligence.id])
  if (!proposal.supportingIntelligenceIds.length || proposal.supportingIntelligenceIds.some((id) => !allowedIntelligence.has(id))) {
    throw new Error('recommendation cites intelligence outside the bounded candidate')
  }

  const allowedClaims = new Set(candidate.goalImpact.evidenceClaimIds)
  if (!proposal.supportingClaimIds.length || proposal.supportingClaimIds.some((id) => !allowedClaims.has(id))) {
    throw new Error('recommendation cites ungrounded evidence claims')
  }

  const allowedRevisionIds = new Set(candidate.beliefRevisions.map((revision) => revision.id))
  const revisionIds = [...new Set([
    ...decision.materialRevisionIds,
    ...(proposal.supportingBeliefRevisionIds ?? []),
  ])]
  if (revisionIds.some((id) => !allowedRevisionIds.has(id))) throw new Error('recommendation cites an unrelated belief revision')

  const evidenceBounds = [
    candidate.intelligence.confidence,
    candidate.goalImpact.confidence,
    ...candidate.beliefRevisions
      .filter((revision) => revisionIds.includes(revision.id))
      .map((revision) => revision.revisedConfidence),
  ].filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  let confidence = Math.min(proposal.confidence, ...(evidenceBounds.length ? evidenceBounds : [proposal.confidence]))

  const contradictory = decision.contradictory || candidate.intelligence.status === 'contested' || hasProvenanceContradiction(candidate)
  let rationale = `Mechanism: ${normalized(candidate.goalImpact.mechanism)} Goal impact: ${normalized(candidate.goalImpact.impact)} Proposed action: ${normalized(proposal.proposedAction)} Rationale: ${normalized(proposal.rationale)}`
  if (contradictory) {
    confidence = Math.min(confidence, CONTESTED_RECOMMENDATION_CONFIDENCE_CAP)
    if (!/(contradict|uncertain|contested|counter-evidence|counterevidence)/i.test(rationale)) {
      rationale = `${rationale} Uncertainty remains because the underlying intelligence is contested or has contradictory evidence.`
    }
  }

  return {
    goalId: candidate.goal.id,
    title: normalized(proposal.title),
    recommendation: normalized(proposal.proposedAction),
    rationale,
    confidence,
    expectedImpact: normalized(proposal.expectedImpact),
    urgency: proposal.urgency,
    reversibility: proposal.reversibility,
    riskClassification: proposal.risk,
    requiredAuthority: proposal.requiredAuthority,
    intelligenceItemIds: [...new Set(proposal.supportingIntelligenceIds)],
    beliefRevisionIds: revisionIds,
    evidenceClaimIds: [...new Set(proposal.supportingClaimIds)],
    provenance: {
      source: 'material-intelligence-recommendation-runtime',
      trigger: decision.kind,
      expectedOutcome: normalized(proposal.expectedOutcome),
    },
  }
}

export function boundRecommendationCandidates(candidates: RecommendationCandidate[]) {
  return candidates
    .map((candidate) => ({ candidate, decision: classifyRecommendationTrigger(candidate) }))
    .filter((entry): entry is { candidate: RecommendationCandidate; decision: TriggerDecision } => Boolean(entry.decision))
    .sort((a, b) => b.decision.rank - a.decision.rank
      || b.candidate.goalImpact.confidence - a.candidate.goalImpact.confidence
      || numeric(b.candidate.intelligence.materiality) - numeric(a.candidate.intelligence.materiality)
      || a.candidate.intelligence.id.localeCompare(b.candidate.intelligence.id))
    .slice(0, RECOMMENDATION_CANDIDATE_LIMIT)
}

export async function runMaterialRecommendationRuntime(input: {
  store: RecommendationRuntimeStore
  proposer: RecommendationProposer
}) {
  const bounded = boundRecommendationCandidates(await input.store.loadCandidates())
  let proposed = 0
  let persisted = 0
  let duplicateSuppressed = 0
  let rejected = 0

  for (const { candidate, decision } of bounded) {
    const proposalFingerprint = recommendationTriggerFingerprint(candidate, decision)
    if (await input.store.hasProposalFingerprint(proposalFingerprint)) {
      duplicateSuppressed += 1
      continue
    }

    const proposal = await input.proposer({
      trigger: decision.kind,
      triggerFingerprint: proposalFingerprint,
      goal: candidate.goal,
      intelligence: candidate.intelligence,
      goalImpact: candidate.goalImpact,
      beliefRevisions: candidate.beliefRevisions,
    })
    if (!proposal) continue
    proposed += 1

    let validated: CreateGroundedRecommendationInput
    try {
      validated = validateRecommendationProposal(candidate, decision, proposal)
    } catch {
      rejected += 1
      continue
    }

    await input.store.persist({
      ...validated,
      provenance: {
        ...(validated.provenance ?? {}),
        proposalFingerprint,
        goalImpactFingerprint: candidate.goalImpact.synthesisFingerprint,
      },
    })
    persisted += 1
  }

  return { candidates: bounded.length, proposed, persisted, duplicateSuppressed, rejected }
}
