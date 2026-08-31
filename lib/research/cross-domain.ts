export const CROSS_DOMAIN_SYNTHESIS_DESK = {
  id: 'cross-domain-synthesis',
  title: 'Cross-Domain Synthesis & Wildcard Discovery',
  standingMission:
    'Continuously inspect intelligence across domains for evidence-backed connections, second-order consequences, opportunities, threats, contradictions, blind spots, and weak signals that no single research desk is likely to surface alone.',
  cadence: {
    synthesisIntervalHours: 12,
    wildcardIntervalHours: 24,
    reassessAfterMaterialChange: true,
  },
  standingQuestions: [
    'What developments appear causally or strategically related?',
    'What second-order consequences follow?',
    'What opportunities emerge from combinations of trends?',
    'What threats become visible only when multiple domains are considered together?',
    'Which assumptions are contradicted by developments elsewhere?',
    'What does the user probably not know to ask about?',
    'What important domain are we not monitoring at all?',
    'Which weak signals are becoming a pattern?',
  ],
} as const

export const WILDCARD_CATEGORIES = [
  'emerging-technologies',
  'unusual-industries',
  'regulatory-changes',
  'scientific-breakthroughs',
  'demographic-changes',
  'infrastructure-shifts',
  'geopolitical-developments',
  'new-business-models',
  'supply-chain-changes',
  'cultural-behavioral-changes',
] as const

export type WildcardCategory = (typeof WILDCARD_CATEGORIES)[number]
export type EpistemicKind = 'source_fact' | 'inference' | 'synthesis' | 'recommendation'
export type SourceQuality = 'official' | 'academic-preprint' | 'academic-institution' | 'primary' | 'independent' | 'community' | 'unknown'
export type EvidenceStance = 'supports' | 'contradicts' | 'context'
export type ConnectionKind = 'causal' | 'strategic' | 'constraint' | 'contradiction' | 'weak-signal-pattern'
export type Materiality = 'low' | 'medium' | 'high' | 'critical'
export type Novelty = 'known' | 'incremental' | 'novel' | 'wildcard'

export type ConstituentIntelligence = {
  id: string
  domain: string
  statement: string
  epistemicKind: Exclude<EpistemicKind, 'synthesis' | 'recommendation'>
  confidence: number
  sourceQuality: SourceQuality
  sourceIds: string[]
  independenceKeys?: string[]
  observedAt: string
  stance?: EvidenceStance
  tags?: string[]
  assumptions?: string[]
}

export type AffectedTarget = {
  kind: 'objective' | 'domain'
  id: string
  label?: string
}

export type SynthesisCandidate = {
  id: string
  constituentIds: string[]
  connectionKind: ConnectionKind
  inferredConnection: string
  mechanism: string
  mechanismEvidenceIds: string[]
  assumptions: string[]
  counterarguments: string[]
  implications: string[]
  recommendedFollowUpResearch: string[]
  affectedTargets: AffectedTarget[]
  confidence: number
  materiality: Materiality
  novelty: Novelty
}

export type SynthesisArtifact = {
  id: string
  epistemicKind: 'synthesis'
  constituentIntelligence: ConstituentIntelligence[]
  inferredConnection: string
  connectionKind: ConnectionKind
  mechanism: string
  confidence: number
  assumptions: string[]
  counterarguments: string[]
  implications: Array<{ epistemicKind: 'inference'; statement: string }>
  recommendedFollowUpResearch: string[]
  affectedTargets: AffectedTarget[]
  materiality: Materiality
  novelty: Novelty
  contradictoryEvidence: ConstituentIntelligence[]
  evidenceSummary: {
    distinctDomains: number
    distinctSources: number
    independentGroups: number
    weakOnly: boolean
  }
}

export type RecommendationArtifact = {
  epistemicKind: 'recommendation'
  synthesisId: string
  recommendation: string
  assumptions: string[]
}

export type RejectedSynthesis = {
  accepted: false
  candidateId: string
  reasons: string[]
}

export type AcceptedSynthesis = {
  accepted: true
  artifact: SynthesisArtifact
  recommendations: RecommendationArtifact[]
}

export type SynthesisDecision = AcceptedSynthesis | RejectedSynthesis

export type WildcardRelevancePath = {
  development: string
  mechanism: string
  affectedObjectiveOrDomain: AffectedTarget
  potentialImplication: string
}

export type WildcardCandidate = {
  id: string
  category: WildcardCategory
  discoveredDomain: string
  evidence: ConstituentIntelligence[]
  relevancePath: WildcardRelevancePath
  confidence: number
  materiality: Materiality
  novelty: Novelty
  followUpResearch: string[]
}

export type WildcardDecision =
  | {
      accepted: true
      candidate: WildcardCandidate
      monitoringGap: boolean
      epistemicPath: {
        fact: ConstituentIntelligence[]
        inference: WildcardRelevancePath
        synthesis: string
      }
    }
  | { accepted: false; candidateId: string; reasons: string[] }

export type WeakSignalPattern = {
  patternKey: string
  signalIds: string[]
  domains: string[]
  sourceIds: string[]
  mechanism: string
  confidence: number
}

const WEAK_SOURCE_QUALITIES = new Set<SourceQuality>(['community', 'unknown'])
const MATERIALITY_WEIGHT: Record<Materiality, number> = { low: 1, medium: 2, high: 3, critical: 4 }

function normalized(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

function nonEmpty(value: string): boolean {
  return normalized(value).length > 0
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

function evidenceForCandidate(candidate: SynthesisCandidate, evidence: ConstituentIntelligence[]): ConstituentIntelligence[] {
  const byId = new Map(evidence.map((item) => [item.id, item]))
  return unique(candidate.constituentIds).map((id) => byId.get(id)).filter((item): item is ConstituentIntelligence => Boolean(item))
}

function independentGroups(evidence: ConstituentIntelligence[]): string[] {
  return unique(evidence.flatMap((item) => item.independenceKeys?.length ? item.independenceKeys : item.sourceIds))
}

function distinctSourceIds(evidence: ConstituentIntelligence[]): string[] {
  return unique(evidence.flatMap((item) => item.sourceIds))
}

function contradictionEvidence(evidence: ConstituentIntelligence[]): ConstituentIntelligence[] {
  return evidence.filter((item) => item.stance === 'contradicts')
}

function allWeak(evidence: ConstituentIntelligence[]): boolean {
  return evidence.length > 0 && evidence.every((item) => WEAK_SOURCE_QUALITIES.has(item.sourceQuality))
}

function confidenceCeiling(args: {
  candidate: SynthesisCandidate
  evidence: ConstituentIntelligence[]
  contradictions: ConstituentIntelligence[]
}): number {
  const { candidate, evidence, contradictions } = args
  const groups = independentGroups(evidence)
  const weakOnly = allWeak(evidence)
  let ceiling = 0.95

  if (groups.length <= 1) ceiling = Math.min(ceiling, 0.55)
  if (weakOnly) ceiling = Math.min(ceiling, 0.4)
  if (candidate.connectionKind === 'causal' && groups.length < 2) ceiling = Math.min(ceiling, 0.35)
  if (contradictions.length > 0) ceiling = Math.min(ceiling, 0.65)
  if (contradictions.some((item) => !WEAK_SOURCE_QUALITIES.has(item.sourceQuality))) ceiling = Math.min(ceiling, 0.55)
  return ceiling
}

/**
 * Deterministic epistemic gate around model-proposed synthesis.
 * The model may propose a relationship. Code decides whether that proposal is
 * sufficiently grounded to become a synthesis artifact at all.
 */
export function evaluateSynthesisCandidate(
  candidate: SynthesisCandidate,
  availableEvidence: ConstituentIntelligence[],
): SynthesisDecision {
  const evidence = evidenceForCandidate(candidate, availableEvidence)
  const evidenceIds = new Set(evidence.map((item) => item.id))
  const mechanismEvidence = unique(candidate.mechanismEvidenceIds).filter((id) => evidenceIds.has(id))
  const domains = unique(evidence.map((item) => normalized(item.domain)))
  const sources = distinctSourceIds(evidence)
  const groups = independentGroups(evidence)
  const contradictions = contradictionEvidence(evidence)
  const reasons: string[] = []

  if (evidence.length < 2) reasons.push('cross-domain synthesis requires at least two constituent intelligence items')
  if (domains.length < 2) reasons.push('cross-domain synthesis requires evidence from at least two distinct domains')
  if (!nonEmpty(candidate.inferredConnection)) reasons.push('inferred connection is required')
  if (!nonEmpty(candidate.mechanism)) reasons.push('explicit mechanism is required')
  if (mechanismEvidence.length < 2) reasons.push('mechanism must be grounded in at least two constituent intelligence items')
  if (candidate.constituentIds.some((id) => !evidenceIds.has(id))) reasons.push('candidate cites constituent intelligence that is not available')
  if (!candidate.affectedTargets.length) reasons.push('synthesis must identify an affected objective or domain')
  if (!candidate.implications.some(nonEmpty)) reasons.push('synthesis must state at least one potential implication')

  const mechanismDomains = unique(evidence.filter((item) => mechanismEvidence.includes(item.id)).map((item) => normalized(item.domain)))
  if (mechanismDomains.length < 2) reasons.push('mechanism evidence must itself cross domain boundaries')

  if (candidate.connectionKind === 'causal') {
    if (groups.length < 2) reasons.push('causal synthesis requires at least two independent evidence groups')
    if (allWeak(evidence)) reasons.push('causal synthesis cannot be supported only by weak sources')
  }

  if (contradictions.length > 0 && !candidate.counterarguments.some(nonEmpty)) {
    reasons.push('contradictory evidence exists but no counterargument is preserved')
  }

  if (allWeak(evidence) && MATERIALITY_WEIGHT[candidate.materiality] >= MATERIALITY_WEIGHT.high) {
    reasons.push('weak-source-only evidence cannot support a high-materiality conclusion')
  }

  if (reasons.length) return { accepted: false, candidateId: candidate.id, reasons }

  const ceiling = confidenceCeiling({ candidate, evidence, contradictions })
  const confidence = Number(Math.min(clamp(candidate.confidence), ceiling).toFixed(3))
  const counterarguments = unique([
    ...candidate.counterarguments.filter(nonEmpty),
    ...contradictions.map((item) => `Contradictory evidence: ${item.statement}`),
  ])

  const artifact: SynthesisArtifact = {
    id: candidate.id,
    epistemicKind: 'synthesis',
    constituentIntelligence: evidence,
    inferredConnection: candidate.inferredConnection.trim(),
    connectionKind: candidate.connectionKind,
    mechanism: candidate.mechanism.trim(),
    confidence,
    assumptions: unique(candidate.assumptions.map((item) => item.trim())),
    counterarguments,
    implications: unique(candidate.implications.map((item) => item.trim())).map((statement) => ({
      epistemicKind: 'inference' as const,
      statement,
    })),
    recommendedFollowUpResearch: unique(candidate.recommendedFollowUpResearch.map((item) => item.trim())),
    affectedTargets: candidate.affectedTargets,
    materiality: candidate.materiality,
    novelty: candidate.novelty,
    contradictoryEvidence: contradictions,
    evidenceSummary: {
      distinctDomains: domains.length,
      distinctSources: sources.length,
      independentGroups: groups.length,
      weakOnly: allWeak(evidence),
    },
  }

  return {
    accepted: true,
    artifact,
    recommendations: artifact.recommendedFollowUpResearch.map((recommendation) => ({
      epistemicKind: 'recommendation' as const,
      synthesisId: artifact.id,
      recommendation,
      assumptions: artifact.assumptions,
    })),
  }
}

export function evaluateWildcardCandidate(args: {
  candidate: WildcardCandidate
  monitoredDomains: string[]
  activeObjectiveIds: string[]
}): WildcardDecision {
  const { candidate } = args
  const reasons: string[] = []
  const path = candidate.relevancePath
  const evidenceSources = distinctSourceIds(candidate.evidence)
  const groups = independentGroups(candidate.evidence)
  const target = path.affectedObjectiveOrDomain
  const monitored = new Set(args.monitoredDomains.map(normalized))
  const objectives = new Set(args.activeObjectiveIds.map(normalized))

  if (!candidate.evidence.length) reasons.push('wildcard discovery requires source evidence')
  if (!nonEmpty(path.development)) reasons.push('wildcard relevance path requires a development')
  if (!nonEmpty(path.mechanism)) reasons.push('wildcard relevance path requires a mechanism')
  if (!target?.id || !target.kind) reasons.push('wildcard relevance path requires an affected objective or domain')
  if (!nonEmpty(path.potentialImplication)) reasons.push('wildcard relevance path requires a potential implication')

  const targetKnown = target?.kind === 'objective'
    ? objectives.has(normalized(target.id))
    : monitored.has(normalized(target.id))
  if (!targetKnown) reasons.push('wildcard has no explicit relevance path to an active objective or monitored domain')

  if (allWeak(candidate.evidence) && MATERIALITY_WEIGHT[candidate.materiality] >= MATERIALITY_WEIGHT.high) {
    reasons.push('one or more weak sources cannot justify a dramatic wildcard conclusion')
  }
  if (candidate.confidence > 0.7 && groups.length < 2) {
    reasons.push('high-confidence wildcard relevance requires independent corroboration')
  }
  if (candidate.evidence.some((item) => !item.sourceIds.length)) reasons.push('wildcard evidence must retain source provenance')

  if (reasons.length) return { accepted: false, candidateId: candidate.id, reasons }

  return {
    accepted: true,
    candidate: {
      ...candidate,
      confidence: Number(Math.min(clamp(candidate.confidence), groups.length <= 1 ? 0.6 : 0.9).toFixed(3)),
    },
    monitoringGap: !monitored.has(normalized(candidate.discoveredDomain)),
    epistemicPath: {
      fact: candidate.evidence,
      inference: path,
      synthesis: `${path.development} may matter because ${path.mechanism}; this could affect ${target.label ?? target.id} via ${path.potentialImplication}`,
    },
  }
}

/**
 * A weak signal becomes a pattern only after recurrence across genuinely
 * independent evidence. Topic similarity by itself is not enough: callers
 * must provide the same explicit patternKey and mechanism.
 */
export function detectWeakSignalPatterns(
  signals: Array<ConstituentIntelligence & { patternKey?: string; mechanism?: string }>,
): WeakSignalPattern[] {
  const groups = new Map<string, typeof signals>()
  for (const signal of signals) {
    const key = normalized(signal.patternKey ?? '')
    if (!key || !nonEmpty(signal.mechanism ?? '')) continue
    groups.set(key, [...(groups.get(key) ?? []), signal])
  }

  return [...groups.entries()].flatMap(([patternKey, items]) => {
    const sourceIds = distinctSourceIds(items)
    const independence = independentGroups(items)
    if (items.length < 3 || independence.length < 2) return []
    const mechanisms = unique(items.map((item) => normalized(item.mechanism ?? '')))
    if (mechanisms.length !== 1) return []

    const domains = unique(items.map((item) => normalized(item.domain)))
    const avgConfidence = items.reduce((sum, item) => sum + clamp(item.confidence), 0) / items.length
    const diversityBoost = Math.min(0.12, (independence.length - 1) * 0.04 + Math.max(0, domains.length - 1) * 0.02)
    return [{
      patternKey,
      signalIds: items.map((item) => item.id).sort(),
      domains,
      sourceIds,
      mechanism: items[0].mechanism!.trim(),
      confidence: Number(Math.min(0.8, avgConfidence * 0.7 + diversityBoost).toFixed(3)),
    }]
  })
}

/** Rotates exploration so wildcard work is deliberate rather than random trivia. */
export function wildcardCategoriesForCycle(cycle: number, count = 3): WildcardCategory[] {
  const safeCount = Math.max(1, Math.min(WILDCARD_CATEGORIES.length, Math.floor(count)))
  const start = ((Math.floor(cycle) % WILDCARD_CATEGORIES.length) + WILDCARD_CATEGORIES.length) % WILDCARD_CATEGORIES.length
  return Array.from({ length: safeCount }, (_, index) => WILDCARD_CATEGORIES[(start + index) % WILDCARD_CATEGORIES.length])
}

export function buildCrossDomainSynthesisInstructions(): string {
  return [
    `You are Caye's ${CROSS_DOMAIN_SYNTHESIS_DESK.title} desk.`,
    `Standing mission: ${CROSS_DOMAIN_SYNTHESIS_DESK.standingMission}`,
    'Inspect intelligence ACROSS domains. Do not connect facts merely because they are recent, share vocabulary, or move together.',
    'Every proposed synthesis must cite constituent intelligence IDs, name an explicit mechanism, and identify which constituent items ground that mechanism.',
    'A causal connection requires stronger evidence than a strategic relationship. Correlation is not causation; label uncertainty rather than upgrading association into cause.',
    'Preserve contradictory evidence and assumptions. One weak source must never drive a dramatic conclusion.',
    'Keep epistemic layers separate: SOURCE FACT is observed evidence; INFERENCE is a derived implication; SYNTHESIS is a cross-domain connection; RECOMMENDATION is a proposed next step.',
    'Actively look for second-order consequences, opportunities, threats, contradicted assumptions, monitoring gaps, and weak signals that are becoming patterns.',
    `Standing questions:\n${CROSS_DOMAIN_SYNTHESIS_DESK.standingQuestions.map((question, index) => `${index + 1}. ${question}`).join('\n')}`,
  ].join('\n\n')
}

export function buildWildcardDiscoveryInstructions(categories: WildcardCategory[]): string {
  return [
    `Explore outside known user interests in these deliberate wildcard categories: ${categories.join(', ')}.`,
    'Do not return trivia. Reject any development without an explicit relevance path.',
    'For every candidate, provide exactly this chain: development -> mechanism -> affected objective/domain -> potential implication.',
    'Search for emerging technologies, unusual industries, regulation, science, demographics, infrastructure, geopolitics, business models, supply chains, and cultural/behavioral change as directed by the category rotation.',
    'Prefer primary/official/academic evidence. Preserve source provenance, uncertainty, and credible contradictory evidence.',
    'A newly discovered domain may be a monitoring gap only when its relevance to an existing objective or monitored domain is explicit.',
  ].join('\n\n')
}
