import { createHash } from 'node:crypto'
import {
  detectWeakSignalPatterns,
  evaluateSynthesisCandidate,
  evaluateWildcardCandidate,
  type AffectedTarget,
  type ConstituentIntelligence,
  type Materiality,
  type SynthesisArtifact,
  type SynthesisCandidate,
  type WildcardCandidate,
  type WildcardDecision,
  type WeakSignalPattern,
} from './cross-domain'

export const CROSS_DOMAIN_CANDIDATE_LIMIT = 24
export const CROSS_DOMAIN_RELATION_LIMIT = 36
export const CROSS_DOMAIN_CLAIM_LIMIT = 36
export const CROSS_DOMAIN_BELIEF_REVISION_LIMIT = 12

export type CrossDomainObjective = {
  id: string
  title: string
  description?: string | null
  priority?: string | null
}

export type CrossDomainContext = {
  evidence: ConstituentIntelligence[]
  activeObjectives: CrossDomainObjective[]
  monitoredDomains: string[]
  weakSignals: Array<ConstituentIntelligence & { patternKey?: string; mechanism?: string }>
  recentBeliefRevisionIds: string[]
  trigger: 'periodic' | 'material-belief-change'
}

export type CrossDomainProposalBundle = {
  syntheses: SynthesisCandidate[]
  wildcards: WildcardCandidate[]
}

export type PersistedSynthesis = {
  itemId: string
  fingerprint: string
  changed: boolean
}

export interface CrossDomainRuntimeStore {
  loadContext(): Promise<CrossDomainContext>
  persistSynthesis(artifact: SynthesisArtifact, fingerprint: string): Promise<PersistedSynthesis>
  persistGroundedRelation(input: {
    synthesisItemId: string
    constituentItemId: string
    relationType: 'contradicts' | 'causes' | 'implicates' | 'related'
    confidence: number
    evidenceClaimIds: string[]
    fingerprint: string
  }): Promise<void>
  claimIdsForItems(itemIds: string[]): Promise<Record<string, string[]>>
  linkObjectiveImpact(input: {
    synthesisItemId: string
    goalId: string
    mechanism: string
    impact: string
    confidence: number
    evidenceClaimIds: string[]
    fingerprint: string
  }): Promise<void>
  queueFollowUpResearch(input: {
    question: string
    affectedTargets: AffectedTarget[]
    synthesisItemId: string
  }): Promise<void>
  persistWildcard(decision: Extract<WildcardDecision, { accepted: true }>, fingerprint: string): Promise<void>
  raiseStrategicAttention(input: {
    synthesisItemId: string
    fingerprint: string
    title: string
    summary: string
    materiality: Materiality
  }): Promise<boolean>
}

export type CrossDomainReasoner = (context: CrossDomainContext) => Promise<CrossDomainProposalBundle>

export type CrossDomainRunResult = {
  trigger: CrossDomainContext['trigger']
  candidates: number
  accepted: number
  rejected: Array<{ id: string; reasons: string[] }>
  weakSignalPatterns: WeakSignalPattern[]
  wildcardsAccepted: number
  wildcardsRejected: Array<{ id: string; reasons: string[] }>
  persisted: number
  changed: number
  alertsRaised: number
  followUpsQueued: number
}

const MATERIALITY_RANK: Record<Materiality, number> = { low: 1, medium: 2, high: 3, critical: 4 }

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function synthesisFingerprint(artifact: SynthesisArtifact): string {
  return createHash('sha256').update(stable({
    connectionKind: artifact.connectionKind,
    constituentIds: artifact.constituentIntelligence.map((item) => item.id).sort(),
    inferredConnection: artifact.inferredConnection,
    mechanism: artifact.mechanism,
    implications: artifact.implications.map((item) => item.statement).sort(),
    affectedTargets: [...artifact.affectedTargets].sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`)),
    contradictoryEvidenceIds: artifact.contradictoryEvidence.map((item) => item.id).sort(),
    confidence: artifact.confidence,
    materiality: artifact.materiality,
  })).digest('hex')
}

export function wildcardFingerprint(decision: Extract<WildcardDecision, { accepted: true }>): string {
  return createHash('sha256').update(stable({
    category: decision.candidate.category,
    discoveredDomain: decision.candidate.discoveredDomain,
    evidenceIds: decision.candidate.evidence.map((item) => item.id).sort(),
    relevancePath: decision.candidate.relevancePath,
    confidence: decision.candidate.confidence,
    materiality: decision.candidate.materiality,
  })).digest('hex')
}

export function relationTypeForSynthesis(artifact: SynthesisArtifact): 'contradicts' | 'causes' | 'implicates' | 'related' {
  if (artifact.connectionKind === 'contradiction') return 'contradicts'
  if (artifact.connectionKind === 'causal') return 'causes'
  if (artifact.connectionKind === 'strategic' || artifact.connectionKind === 'constraint' || artifact.connectionKind === 'weak-signal-pattern') return 'implicates'
  return 'related'
}

export function shouldRaiseStrategicAttention(artifact: SynthesisArtifact, activeObjectiveIds: Set<string>): boolean {
  if (MATERIALITY_RANK[artifact.materiality] < MATERIALITY_RANK.high) return false
  return artifact.affectedTargets.some((target) => target.kind === 'objective' && activeObjectiveIds.has(target.id))
}

function compactQuestions(questions: string[]): string[] {
  return [...new Set(questions.map((question) => question.trim()).filter(Boolean))].slice(0, 4)
}

/**
 * The model proposes; deterministic cross-domain gates decide. Persistence is
 * deliberately downstream of acceptance so speculative connections never gain
 * durability merely because a provider emitted valid JSON.
 */
export async function runCrossDomainSynthesis(args: {
  store: CrossDomainRuntimeStore
  reasoner: CrossDomainReasoner
}): Promise<CrossDomainRunResult> {
  const context = await args.store.loadContext()
  const proposals = await args.reasoner(context)
  const activeObjectiveIds = new Set(context.activeObjectives.map((goal) => goal.id))
  const weakSignalPatterns = detectWeakSignalPatterns(context.weakSignals)
  const claimIdsByItem = await args.store.claimIdsForItems(context.evidence.map((item) => item.id))
  const rejected: Array<{ id: string; reasons: string[] }> = []
  const wildcardsRejected: Array<{ id: string; reasons: string[] }> = []
  let accepted = 0
  let wildcardsAccepted = 0
  let persisted = 0
  let changed = 0
  let alertsRaised = 0
  let followUpsQueued = 0

  for (const candidate of proposals.syntheses.slice(0, 12)) {
    const decision = evaluateSynthesisCandidate(candidate, context.evidence)
    if (!decision.accepted) {
      rejected.push({ id: decision.candidateId, reasons: decision.reasons })
      continue
    }

    accepted += 1
    const artifact = decision.artifact
    const fingerprint = synthesisFingerprint(artifact)
    const stored = await args.store.persistSynthesis(artifact, fingerprint)
    persisted += 1
    if (stored.changed) changed += 1

    const relationType = relationTypeForSynthesis(artifact)
    for (const constituent of artifact.constituentIntelligence) {
      const evidenceClaimIds = claimIdsByItem[constituent.id] ?? []
      if (!evidenceClaimIds.length) continue
      await args.store.persistGroundedRelation({
        synthesisItemId: stored.itemId,
        constituentItemId: constituent.id,
        relationType,
        confidence: artifact.confidence,
        evidenceClaimIds,
        fingerprint,
      })
    }

    const allClaimIds = [...new Set(artifact.constituentIntelligence.flatMap((item) => claimIdsByItem[item.id] ?? []))]
    for (const target of artifact.affectedTargets) {
      if (target.kind !== 'objective' || !activeObjectiveIds.has(target.id)) continue
      await args.store.linkObjectiveImpact({
        synthesisItemId: stored.itemId,
        goalId: target.id,
        mechanism: artifact.mechanism,
        impact: artifact.implications.map((item) => item.statement).join(' '),
        confidence: artifact.confidence,
        evidenceClaimIds: allClaimIds,
        fingerprint,
      })
    }

    // An unchanged synthesis remains useful durable context, but does not keep
    // spawning investigations or poking the founder with the same conclusion.
    if (stored.changed) {
      for (const question of compactQuestions(artifact.recommendedFollowUpResearch)) {
        await args.store.queueFollowUpResearch({ question, affectedTargets: artifact.affectedTargets, synthesisItemId: stored.itemId })
        followUpsQueued += 1
      }

      if (shouldRaiseStrategicAttention(artifact, activeObjectiveIds)) {
        const raised = await args.store.raiseStrategicAttention({
          synthesisItemId: stored.itemId,
          fingerprint,
          title: artifact.inferredConnection.slice(0, 160),
          summary: artifact.implications.map((item) => item.statement).join(' '),
          materiality: artifact.materiality,
        })
        if (raised) alertsRaised += 1
      }
    }
  }

  for (const candidate of proposals.wildcards.slice(0, 6)) {
    const decision = evaluateWildcardCandidate({
      candidate,
      monitoredDomains: context.monitoredDomains,
      activeObjectiveIds: context.activeObjectives.map((goal) => goal.id),
    })
    if (!decision.accepted) {
      wildcardsRejected.push({ id: decision.candidateId, reasons: decision.reasons })
      continue
    }
    wildcardsAccepted += 1
    await args.store.persistWildcard(decision, wildcardFingerprint(decision))
  }

  return {
    trigger: context.trigger,
    candidates: proposals.syntheses.length,
    accepted,
    rejected,
    weakSignalPatterns,
    wildcardsAccepted,
    wildcardsRejected,
    persisted,
    changed,
    alertsRaised,
    followUpsQueued,
  }
}
