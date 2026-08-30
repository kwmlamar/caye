export const DECISION_INTELLIGENCE_VERSION = 1 as const

export const DECISION_LIMITS = {
  alternatives: 5,
  assumptions: 8,
  evidence: 16,
  unknowns: 8,
  consequencesPerAlternative: 8,
} as const

export type EpistemicKind = 'known' | 'inferred'
export type EvidenceDirection = 'supports' | 'contradicts' | 'context'
export type ConfidenceBand = 'low' | 'medium' | 'high'
export type Reversibility = 'reversible' | 'partially_reversible' | 'irreversible'
export type ConsequenceMagnitude = 'minor' | 'material' | 'major'
export type ConsequenceLikelihood = 'unlikely' | 'plausible' | 'likely'
export type DecisionDisposition = 'recommend' | 'investigate' | 'defer'
export type AuthorityDisposition = 'autonomous' | 'approval_required' | 'recommendation_only'

export type DecisionEvidence = {
  ref: string
  statement: string
  epistemicKind: EpistemicKind
  direction: EvidenceDirection
  confidence: ConfidenceBand
}

export type DecisionAssumption = {
  id: string
  statement: string
  confidence: ConfidenceBand
}

export type DecisionConsequence = {
  dimension: string
  direction: 'benefit' | 'cost' | 'risk'
  magnitude: ConsequenceMagnitude
  likelihood: ConsequenceLikelihood
  rationale: string
}

export type DecisionAlternative = {
  id: string
  label: string
  description: string
  reversibility: Reversibility
  requiresConsequentialAction: boolean
  evidenceRefs: string[]
  assumptions: DecisionAssumption[]
  consequences: DecisionConsequence[]
}

export type DecisionPrediction = {
  alternativeId: string
  expectation: string
  observable: string
  horizon: string
  confidence: ConfidenceBand
}

export type DecisionAnalysisInput = {
  workspaceId: string
  situation: string
  alternatives: DecisionAlternative[]
  evidence: DecisionEvidence[]
  unknowns: string[]
  predictions?: DecisionPrediction[]
}

export type DecisionRecommendation = {
  disposition: DecisionDisposition
  alternativeId: string | null
  confidence: ConfidenceBand
  authority: AuthorityDisposition
  reasons: string[]
  evidenceState: 'sufficient' | 'ambiguous' | 'contradictory' | 'missing'
}

export type DecisionRecord = {
  schemaVersion: typeof DECISION_INTELLIGENCE_VERSION
  workspaceId: string
  situation: string
  alternatives: DecisionAlternative[]
  evidence: DecisionEvidence[]
  unknowns: string[]
  predictions: DecisionPrediction[]
  recommendation: DecisionRecommendation
}

export type DecisionOutcome = {
  alternativeId: string
  observed: string
  evidenceRefs: string[]
  verdict: 'matched' | 'missed' | 'inconclusive'
  notes: string[]
}

export type DecisionOutcomeComparison = {
  schemaVersion: typeof DECISION_INTELLIGENCE_VERSION
  workspaceId: string
  alternativeId: string
  prediction: DecisionPrediction | null
  outcome: DecisionOutcome
  comparison: 'supported' | 'disconfirmed' | 'inconclusive' | 'no_prediction'
}

const confidenceRank: Record<ConfidenceBand, number> = { low: 0, medium: 1, high: 2 }
const magnitudeRank: Record<ConsequenceMagnitude, number> = { minor: 1, material: 2, major: 3 }
const likelihoodRank: Record<ConsequenceLikelihood, number> = { unlikely: 1, plausible: 2, likely: 3 }

function clean(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

function assertBoundedString(value: unknown, field: string, max = 1000): asserts value is string {
  if (typeof value !== 'string' || clean(value).length === 0 || value.length > max) {
    throw new Error(`${field} must be a non-empty string no longer than ${max} characters.`)
  }
}

function assertUnique(values: string[], field: string) {
  if (new Set(values).size !== values.length) throw new Error(`${field} must contain unique values.`)
}

function validateInput(input: DecisionAnalysisInput) {
  assertBoundedString(input.workspaceId, 'workspaceId', 128)
  assertBoundedString(input.situation, 'situation', 2000)
  if (!Array.isArray(input.alternatives) || input.alternatives.length < 2 || input.alternatives.length > DECISION_LIMITS.alternatives) {
    throw new Error(`alternatives must contain 2-${DECISION_LIMITS.alternatives} options.`)
  }
  if (!Array.isArray(input.evidence) || input.evidence.length > DECISION_LIMITS.evidence) {
    throw new Error(`evidence must contain at most ${DECISION_LIMITS.evidence} items.`)
  }
  if (!Array.isArray(input.unknowns) || input.unknowns.length > DECISION_LIMITS.unknowns) {
    throw new Error(`unknowns must contain at most ${DECISION_LIMITS.unknowns} items.`)
  }

  const alternativeIds = input.alternatives.map((alternative) => alternative.id)
  assertUnique(alternativeIds, 'alternative ids')
  const evidenceRefs = input.evidence.map((evidence) => evidence.ref)
  assertUnique(evidenceRefs, 'evidence refs')
  const evidenceSet = new Set(evidenceRefs)

  for (const evidence of input.evidence) {
    assertBoundedString(evidence.ref, 'evidence.ref', 256)
    assertBoundedString(evidence.statement, 'evidence.statement', 1200)
  }
  for (const unknown of input.unknowns) assertBoundedString(unknown, 'unknown', 600)

  for (const alternative of input.alternatives) {
    assertBoundedString(alternative.id, 'alternative.id', 128)
    assertBoundedString(alternative.label, 'alternative.label', 160)
    assertBoundedString(alternative.description, 'alternative.description', 1200)
    if (alternative.assumptions.length > DECISION_LIMITS.assumptions) throw new Error(`alternative assumptions exceed ${DECISION_LIMITS.assumptions}.`)
    if (alternative.consequences.length > DECISION_LIMITS.consequencesPerAlternative) throw new Error(`alternative consequences exceed ${DECISION_LIMITS.consequencesPerAlternative}.`)
    assertUnique(alternative.assumptions.map((assumption) => assumption.id), `assumption ids for ${alternative.id}`)
    for (const ref of alternative.evidenceRefs) {
      if (!evidenceSet.has(ref)) throw new Error(`Alternative '${alternative.id}' references unknown evidence '${ref}'.`)
    }
    for (const assumption of alternative.assumptions) {
      assertBoundedString(assumption.id, 'assumption.id', 128)
      assertBoundedString(assumption.statement, 'assumption.statement', 800)
    }
    for (const consequence of alternative.consequences) {
      assertBoundedString(consequence.dimension, 'consequence.dimension', 160)
      assertBoundedString(consequence.rationale, 'consequence.rationale', 800)
    }
  }

  const predictions = input.predictions ?? []
  if (predictions.length > input.alternatives.length) throw new Error('predictions cannot outnumber alternatives.')
  assertUnique(predictions.map((prediction) => prediction.alternativeId), 'prediction alternative ids')
  for (const prediction of predictions) {
    if (!alternativeIds.includes(prediction.alternativeId)) throw new Error(`Prediction references unknown alternative '${prediction.alternativeId}'.`)
    assertBoundedString(prediction.expectation, 'prediction.expectation', 1000)
    assertBoundedString(prediction.observable, 'prediction.observable', 500)
    assertBoundedString(prediction.horizon, 'prediction.horizon', 300)
  }
}

function evidenceFor(alternative: DecisionAlternative, evidenceByRef: Map<string, DecisionEvidence>): DecisionEvidence[] {
  return alternative.evidenceRefs.map((ref) => evidenceByRef.get(ref)).filter((item): item is DecisionEvidence => Boolean(item))
}

function qualitativeNet(alternative: DecisionAlternative): number {
  return alternative.consequences.reduce((net, consequence) => {
    const weight = magnitudeRank[consequence.magnitude] * likelihoodRank[consequence.likelihood]
    return net + (consequence.direction === 'benefit' ? weight : -weight)
  }, 0)
}

function evidenceStrength(alternative: DecisionAlternative, evidenceByRef: Map<string, DecisionEvidence>): number {
  return evidenceFor(alternative, evidenceByRef).reduce((score, evidence) => {
    const strength = confidenceRank[evidence.confidence] + 1
    if (evidence.direction === 'supports') return score + strength
    if (evidence.direction === 'contradicts') return score - strength
    return score
  }, 0)
}

function evidenceState(input: DecisionAnalysisInput): DecisionRecommendation['evidenceState'] {
  if (input.evidence.length === 0) return 'missing'
  const supports = input.evidence.some((item) => item.direction === 'supports')
  const contradicts = input.evidence.some((item) => item.direction === 'contradicts')
  if (supports && contradicts) return 'contradictory'
  if (!supports || input.unknowns.length > 0) return 'ambiguous'
  return 'sufficient'
}

function authorityFor(alternative: DecisionAlternative | undefined): AuthorityDisposition {
  if (!alternative) return 'recommendation_only'
  if (alternative.requiresConsequentialAction || alternative.reversibility === 'irreversible') return 'approval_required'
  return 'autonomous'
}

function recommendation(input: DecisionAnalysisInput): DecisionRecommendation {
  const state = evidenceState(input)
  if (state === 'missing') {
    return {
      disposition: 'investigate', alternativeId: null, confidence: 'low', authority: 'recommendation_only',
      evidenceState: state, reasons: ['No evidence was supplied. Caye cannot choose honestly from an unsupported premise.'],
    }
  }

  const evidenceByRef = new Map(input.evidence.map((item) => [item.ref, item]))
  const ranked = input.alternatives.map((alternative) => ({
    alternative,
    net: qualitativeNet(alternative),
    evidence: evidenceStrength(alternative, evidenceByRef),
    lowConfidenceAssumptions: alternative.assumptions.filter((assumption) => assumption.confidence === 'low').length,
  })).sort((a, b) => b.evidence - a.evidence || b.net - a.net || a.alternative.id.localeCompare(b.alternative.id))

  const top = ranked[0]
  const second = ranked[1]
  const contradictedTop = evidenceFor(top.alternative, evidenceByRef).some((item) => item.direction === 'contradicts' && item.confidence !== 'low')
  const nearTie = Boolean(second) && top.evidence === second.evidence && Math.abs(top.net - second.net) <= 2
  const assumptionRisk = top.lowConfidenceAssumptions > 0

  if (state === 'contradictory' || nearTie || contradictedTop || assumptionRisk) {
    const reasons = [
      state === 'contradictory' ? 'Material evidence points in conflicting directions.' : null,
      nearTie ? 'The leading alternatives are too close to distinguish without pretending at precision.' : null,
      contradictedTop ? 'The leading alternative has material contradictory evidence.' : null,
      assumptionRisk ? 'The leading alternative depends on at least one low-confidence assumption.' : null,
    ].filter((item): item is string => Boolean(item))
    return {
      disposition: 'investigate', alternativeId: null, confidence: 'low', authority: 'recommendation_only',
      evidenceState: state === 'sufficient' ? 'ambiguous' : state, reasons,
    }
  }

  const evidenceGap = top.evidence - (second?.evidence ?? 0)
  const consequenceGap = top.net - (second?.net ?? 0)
  const confidence: ConfidenceBand = state === 'sufficient' && evidenceGap >= 2 && consequenceGap >= 2
    ? 'high'
    : state === 'sufficient' && (evidenceGap > 0 || consequenceGap > 2)
      ? 'medium'
      : 'low'

  if (confidence === 'low') {
    return {
      disposition: 'investigate', alternativeId: null, confidence, authority: 'recommendation_only', evidenceState: 'ambiguous',
      reasons: ['Evidence does not separate the alternatives enough to support a recommendation.'],
    }
  }

  return {
    disposition: 'recommend', alternativeId: top.alternative.id, confidence,
    authority: authorityFor(top.alternative), evidenceState: state,
    reasons: [
      `Evidence favors '${top.alternative.label}' over the bounded alternatives.`,
      top.alternative.reversibility === 'reversible' ? 'The recommended path is reversible.' : `The recommended path is ${top.alternative.reversibility.replace('_', ' ')}.`,
      ...(authorityFor(top.alternative) === 'approval_required' ? ['Execution requires explicit approval; the analysis itself grants no authority.'] : []),
    ],
  }
}

function normalizeAlternative(alternative: DecisionAlternative): DecisionAlternative {
  return {
    ...alternative,
    id: clean(alternative.id), label: clean(alternative.label), description: clean(alternative.description),
    evidenceRefs: [...alternative.evidenceRefs].sort(),
    assumptions: [...alternative.assumptions].map((item) => ({ ...item, id: clean(item.id), statement: clean(item.statement) })).sort((a, b) => a.id.localeCompare(b.id)),
    consequences: [...alternative.consequences].map((item) => ({ ...item, dimension: clean(item.dimension), rationale: clean(item.rationale) })).sort((a, b) => a.dimension.localeCompare(b.dimension) || a.direction.localeCompare(b.direction)),
  }
}

/**
 * Deterministic, bounded decision record. No probability percentages are invented.
 * The caller supplies evidence/alternatives; this layer enforces structure, epistemic
 * boundaries, qualitative tradeoffs, authority awareness and honest abstention.
 */
export function analyzeDecision(input: DecisionAnalysisInput): DecisionRecord {
  validateInput(input)
  const normalized: DecisionAnalysisInput = {
    workspaceId: clean(input.workspaceId), situation: clean(input.situation),
    alternatives: [...input.alternatives].map(normalizeAlternative).sort((a, b) => a.id.localeCompare(b.id)),
    evidence: [...input.evidence].map((item) => ({ ...item, ref: clean(item.ref), statement: clean(item.statement) })).sort((a, b) => a.ref.localeCompare(b.ref)),
    unknowns: [...input.unknowns].map(clean).sort(),
    predictions: [...(input.predictions ?? [])].map((item) => ({ ...item, expectation: clean(item.expectation), observable: clean(item.observable), horizon: clean(item.horizon) })).sort((a, b) => a.alternativeId.localeCompare(b.alternativeId)),
  }
  return {
    schemaVersion: DECISION_INTELLIGENCE_VERSION,
    workspaceId: normalized.workspaceId,
    situation: normalized.situation,
    alternatives: normalized.alternatives,
    evidence: normalized.evidence,
    unknowns: normalized.unknowns,
    predictions: normalized.predictions ?? [],
    recommendation: recommendation(normalized),
  }
}

/** Later outcome interface: compares a recorded qualitative prediction with observed reality. */
export function compareDecisionOutcome(record: DecisionRecord, outcome: DecisionOutcome): DecisionOutcomeComparison {
  if (outcome.alternativeId !== record.recommendation.alternativeId && !record.alternatives.some((item) => item.id === outcome.alternativeId)) {
    throw new Error('Outcome references an alternative outside this decision record.')
  }
  const prediction = record.predictions.find((item) => item.alternativeId === outcome.alternativeId) ?? null
  const comparison = !prediction ? 'no_prediction' : outcome.verdict === 'matched' ? 'supported' : outcome.verdict === 'missed' ? 'disconfirmed' : 'inconclusive'
  return {
    schemaVersion: DECISION_INTELLIGENCE_VERSION,
    workspaceId: record.workspaceId,
    alternativeId: outcome.alternativeId,
    prediction,
    outcome: { ...outcome, observed: clean(outcome.observed), evidenceRefs: [...outcome.evidenceRefs].sort(), notes: [...outcome.notes].map(clean).sort() },
    comparison,
  }
}
