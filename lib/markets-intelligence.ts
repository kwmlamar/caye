export type ThesisEvidenceEffect =
  | 'strengthen'
  | 'weaken'
  | 'contradict'
  | 'invalidate'
  | 'supersede'

export type ThesisStatus = 'active' | 'contested' | 'invalidated' | 'superseded'

export interface ThesisConfidencePoint {
  confidence: number
  observedAt: string
  reason: string
  evidenceClaimId: string
}

export interface MarketThesis {
  id: string
  claim: string
  confidence: number
  confidenceHistory: ThesisConfidencePoint[]
  status: ThesisStatus
  supportingEvidenceClaimIds: string[]
  counterEvidenceClaimIds: string[]
  catalysts: string[]
  invalidationConditions: string[]
  relatedCompanies: string[]
  relatedSectors: string[]
  relatedTechnologies: string[]
  expectedHorizon: string | null
  implications: string[]
  lastReviewedAt: string | null
  nextReviewTrigger: string | null
  supersededByThesisId: string | null
}

export interface ThesisEvidenceUpdate {
  effect: ThesisEvidenceEffect
  evidenceClaimId: string
  observedAt: string
  confidenceDelta?: number
  reason: string
  supersededByThesisId?: string
}

const clampConfidence = (value: number) => Math.max(0, Math.min(1, value))

/**
 * Deterministically applies a reviewed research claim to a durable thesis.
 * Evidence is referenced by canonical research_claim id; raw model text never
 * mutates the thesis claim or expands authority.
 */
export function applyThesisEvidence(thesis: MarketThesis, update: ThesisEvidenceUpdate): MarketThesis {
  if (thesis.status === 'invalidated' || thesis.status === 'superseded') {
    throw new Error('terminal thesis cannot accept evidence updates')
  }
  if (!update.evidenceClaimId.trim()) throw new Error('evidence claim id is required')
  if (!update.reason.trim()) throw new Error('evidence update reason is required')
  if (update.effect === 'supersede' && !update.supersededByThesisId?.trim()) {
    throw new Error('superseding thesis id is required')
  }

  const supporting = new Set(thesis.supportingEvidenceClaimIds)
  const counter = new Set(thesis.counterEvidenceClaimIds)
  let status: ThesisStatus = thesis.status
  let nextConfidence = thesis.confidence
  let supersededByThesisId = thesis.supersededByThesisId

  switch (update.effect) {
    case 'strengthen':
      supporting.add(update.evidenceClaimId)
      counter.delete(update.evidenceClaimId)
      nextConfidence += Math.abs(update.confidenceDelta ?? 0.05)
      if (status === 'contested') status = 'active'
      break
    case 'weaken':
      counter.add(update.evidenceClaimId)
      supporting.delete(update.evidenceClaimId)
      nextConfidence -= Math.abs(update.confidenceDelta ?? 0.05)
      break
    case 'contradict':
      counter.add(update.evidenceClaimId)
      supporting.delete(update.evidenceClaimId)
      nextConfidence -= Math.abs(update.confidenceDelta ?? 0.15)
      status = 'contested'
      break
    case 'invalidate':
      counter.add(update.evidenceClaimId)
      supporting.delete(update.evidenceClaimId)
      nextConfidence = 0
      status = 'invalidated'
      break
    case 'supersede':
      supporting.add(update.evidenceClaimId)
      status = 'superseded'
      supersededByThesisId = update.supersededByThesisId!
      break
  }

  nextConfidence = clampConfidence(nextConfidence)
  return {
    ...thesis,
    confidence: nextConfidence,
    status,
    supportingEvidenceClaimIds: [...supporting],
    counterEvidenceClaimIds: [...counter],
    confidenceHistory: [
      ...thesis.confidenceHistory,
      {
        confidence: nextConfidence,
        observedAt: update.observedAt,
        reason: update.reason,
        evidenceClaimId: update.evidenceClaimId,
      },
    ],
    lastReviewedAt: update.observedAt,
    supersededByThesisId,
  }
}

export type MarketOpportunityKind =
  | 'input_cost_decline'
  | 'regulatory_demand'
  | 'demand_supply_gap'
  | 'capability_new_category'
  | 'market_mismatch'

export interface MarketSignal {
  inputCostsFalling?: boolean
  regulationCreatesDemand?: boolean
  demandGrowing?: boolean
  supplyConstrained?: boolean
  newTechnicalCapability?: boolean
  newProductCategoryPossible?: boolean
  persistentMarketMismatch?: boolean
}

/** Pure classifier used after evidence-backed research has produced structured signals. */
export function detectMarketOpportunityKinds(signal: MarketSignal): MarketOpportunityKind[] {
  const kinds: MarketOpportunityKind[] = []
  if (signal.inputCostsFalling) kinds.push('input_cost_decline')
  if (signal.regulationCreatesDemand) kinds.push('regulatory_demand')
  if (signal.demandGrowing && signal.supplyConstrained) kinds.push('demand_supply_gap')
  if (signal.newTechnicalCapability && signal.newProductCategoryPossible) kinds.push('capability_new_category')
  if (signal.persistentMarketMismatch) kinds.push('market_mismatch')
  return kinds
}

export type MarketsResearchCapability =
  | 'research'
  | 'construct_thesis'
  | 'update_thesis'
  | 'compare_scenarios'
  | 'track_catalyst'
  | 'evaluate_historical_hypothesis'
  | 'paper_simulation'
  | 'detect_opportunity'

const ANALYSIS_ONLY_CAPABILITIES = new Set<string>([
  'research',
  'construct_thesis',
  'update_thesis',
  'compare_scenarios',
  'track_catalyst',
  'evaluate_historical_hypothesis',
  'paper_simulation',
  'detect_opportunity',
])

const PROHIBITED_FINANCIAL_ACTIONS = new Set<string>([
  'place_order',
  'execute_trade',
  'cancel_order',
  'brokerage_transfer',
  'deploy_capital',
  'commit_capital',
  'financial_commitment',
  'buy_security',
  'sell_security',
])

export interface MarketsAuthorityVerdict {
  allowed: boolean
  analysisOnly: boolean
  reason: string
}

/**
 * Hard financial boundary for this subsystem. This intentionally does not
 * delegate to workspace budgets: live financial consequences are outside the
 * markets research desk regardless of model confidence, thesis strength, or
 * existing generic autonomy allowances.
 */
export function decideMarketsResearchAuthority(action: string): MarketsAuthorityVerdict {
  const normalized = action.trim().toLowerCase()
  if (ANALYSIS_ONLY_CAPABILITIES.has(normalized)) {
    return { allowed: true, analysisOnly: true, reason: 'markets_research_capability' }
  }
  if (PROHIBITED_FINANCIAL_ACTIONS.has(normalized)) {
    return { allowed: false, analysisOnly: true, reason: 'live_financial_action_outside_research_authority' }
  }
  return { allowed: false, analysisOnly: true, reason: 'unknown_markets_action_fails_closed' }
}
