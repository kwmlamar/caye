import 'server-only'

import { getAllCurrentClaims, getLatestBriefs, getResearchStatus } from '@/lib/research/runtime'
import {
  highMaterialityIntelligence,
  recentBeliefRevisions,
  strategicIntelligencePriorities,
  unresolvedContradictions,
} from '@/lib/intelligence/query'
import type { IntelligenceScope } from '@/lib/intelligence/identity'
import { sanitizeStrategicHumanOutput } from './presentation'

const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const FOUNDER_INTELLIGENCE_SCOPES: IntelligenceScope[] = [{ kind: 'operator' }, { kind: 'global' }]

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : []
}

function clean(value: string): string {
  return sanitizeStrategicHumanOutput(value.trim())
}

function dedupe(items: string[], limit = 12): string[] {
  const seen = new Set<string>()
  const output: string[] = []
  for (const item of items) {
    const normalized = clean(item)
    const key = normalized.toLowerCase()
    if (!normalized || seen.has(key)) continue
    seen.add(key)
    output.push(normalized)
    if (output.length >= limit) break
  }
  return output
}

function isFresh(createdAt: unknown, nowMs: number): boolean {
  if (typeof createdAt !== 'string') return false
  const timestamp = Date.parse(createdAt)
  return Number.isFinite(timestamp) && timestamp >= nowMs - WEEK_MS && timestamp <= nowMs + 60_000
}

function isMaterialBrief(brief: { revision?: unknown; material_changes?: unknown }): boolean {
  // Revision one establishes a baseline. Later revisions only earn weekly
  // attention when synthesis explicitly recorded a material change.
  if (Number(brief.revision) === 1) return true
  return strings(brief.material_changes).length > 0
}

function numericConfidence(value: unknown): number | null {
  if (value == null) return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

export type StrategicResearchSnapshot = {
  generatedAt: string
  whatChanged: string[]
  strongestBeliefs: Array<{ statement: string; confidence: number | null; contested: boolean }>
  whatYouShouldKnow: string[]
  whatYouMightBeMissing: string[]
  opportunities: string[]
  threatsAndChangedAssumptions: string[]
  recommendedNextActions: string[]
  stillInvestigating: string[]
  changedMindRecently: string[]
  evidenceWouldChangeRecommendations: string[]
}

export async function buildStrategicResearchSnapshot(now = new Date()): Promise<StrategicResearchSnapshot> {
  const nowMs = now.getTime()
  const since = new Date(nowMs - WEEK_MS).toISOString()
  const asOf = now.toISOString()

  const scopeReads = FOUNDER_INTELLIGENCE_SCOPES.map(async (scope) => {
    const [items, contradictions, revisions, priorities] = await Promise.all([
      highMaterialityIntelligence({ scope, minimum: 0.6, limit: 40 }),
      unresolvedContradictions({ scope, limit: 30 }),
      recentBeliefRevisions({ scope, since, limit: 30 }),
      strategicIntelligencePriorities({ scope, asOf, limit: 20 }),
    ])
    return { items, contradictions, revisions, priorities }
  })

  const [claims, briefs, programs, ...intelligenceByScope] = await Promise.all([
    getAllCurrentClaims(),
    getLatestBriefs(),
    getResearchStatus(),
    ...scopeReads,
  ])

  const intelligenceItems = intelligenceByScope.flatMap((result) => result.items)
  const contradictions = intelligenceByScope.flatMap((result) => result.contradictions)
  const beliefRevisions = intelligenceByScope.flatMap((result) => result.revisions)
  const intelligencePriorities = intelligenceByScope.flatMap((result) => result.priorities)

  const freshBriefs = briefs.filter((brief) => isFresh(brief.created_at, nowMs))
  const materialBriefs = freshBriefs.filter(isMaterialBrief)

  const claimBeliefs = claims
    .filter((claim) => claim.status === 'current' || claim.status === 'contested')
    .filter((claim) => !claim.valid_until || Date.parse(claim.valid_until) > nowMs)
    .map((claim) => ({
      statement: clean(String(claim.statement ?? '')),
      confidence: numericConfidence(claim.confidence),
      contested: claim.status === 'contested' || (claim.research_claim_evidence ?? []).some((edge: { stance?: string }) => edge.stance === 'contradicts'),
    }))

  const contestedItemIds = new Set<string>()
  for (const relation of contradictions) {
    if (relation.from_item_id) contestedItemIds.add(String(relation.from_item_id))
    if (relation.to_item_id) contestedItemIds.add(String(relation.to_item_id))
  }

  const durableBeliefs = intelligenceItems
    .filter((item) => item.status === 'current' || item.status === 'contested')
    .filter((item) => !item.valid_until || Date.parse(String(item.valid_until)) > nowMs)
    .map((item) => ({
      statement: clean(String(item.canonical_claim ?? '')),
      confidence: numericConfidence(item.confidence),
      contested: item.status === 'contested' || contestedItemIds.has(String(item.id)),
    }))

  const strongestBeliefs = [...durableBeliefs, ...claimBeliefs]
    .filter((claim) => claim.statement.length > 0)
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
    .filter((belief, index, beliefs) => beliefs.findIndex((candidate) => candidate.statement.toLowerCase() === belief.statement.toLowerCase()) === index)
    .slice(0, 12)

  const contradictionSummaries = contradictions.flatMap((relation) => {
    const from = clean(String(relation.from?.canonical_claim ?? ''))
    const to = clean(String(relation.to?.canonical_claim ?? ''))
    return from && to ? [`Conflicting intelligence: ${from} ↔ ${to}`] : []
  })

  const revisionSummaries = beliefRevisions.flatMap((revision) => {
    const statement = clean(String(revision.item?.canonical_claim ?? ''))
    if (!statement) return []
    const prior = numericConfidence(revision.prior_confidence)
    const revised = numericConfidence(revision.revised_confidence)
    const delta = prior == null || revised == null ? '' : ` (${Math.round(prior * 100)}% → ${Math.round(revised * 100)}%)`
    return [`Belief updated${delta}: ${statement}. ${clean(String(revision.rationale ?? ''))}`]
  })

  const whatChanged = dedupe([
    ...revisionSummaries,
    ...materialBriefs.flatMap((brief) => strings(brief.material_changes)),
  ])
  const whatYouShouldKnow = dedupe([
    ...intelligenceItems.map((item) => String(item.canonical_claim ?? '')),
    ...materialBriefs.map((brief) => String(brief.current_understanding ?? '')),
  ])
  const opportunities = dedupe(materialBriefs.flatMap((brief) => [
    ...strings(brief.recommendations),
    ...strings(brief.implications),
  ]))
  const threatsAndChangedAssumptions = dedupe([
    ...contradictionSummaries,
    ...materialBriefs.flatMap((brief) => strings(brief.conflicting_evidence)),
  ])
  const changedMindRecently = dedupe([
    ...revisionSummaries,
    ...contradictionSummaries,
    ...materialBriefs.flatMap((brief) => strings(brief.conflicting_evidence)),
    ...strongestBeliefs.filter((claim) => claim.contested).map((claim) => `Evidence is contesting: ${claim.statement}`),
  ])
  const evidenceWouldChangeRecommendations = dedupe([
    ...intelligencePriorities.map((priority) => priority.statement),
    ...materialBriefs.flatMap((brief) => strings(brief.unknowns)),
  ])

  const stillInvestigating = dedupe([
    ...intelligencePriorities.map((priority) => priority.statement),
    ...programs.flatMap((program) =>
      (program.research_questions ?? [])
        .filter((question: { status?: string }) => question.status === 'open' || question.status === 'researching')
        .map((question: { question?: string }) => String(question.question ?? ''))
    ),
  ], 20)

  // Wildcard/cross-domain work lands in the same canonical brief substrate. Durable
  // high-materiality intelligence is included here only when it is not already a
  // headline belief/change, preserving evidence-backed novelty without inventing links.
  const knownKeys = new Set([...whatChanged, ...strongestBeliefs.map((item) => item.statement)].map((item) => item.toLowerCase()))
  const whatYouMightBeMissing = dedupe([
    ...intelligenceItems
      .map((item) => String(item.canonical_claim ?? ''))
      .filter((item) => !knownKeys.has(clean(item).toLowerCase())),
    ...materialBriefs.flatMap((brief) => strings(brief.implications)).filter((item) => !knownKeys.has(clean(item).toLowerCase())),
  ])

  return {
    generatedAt: now.toISOString(),
    whatChanged,
    strongestBeliefs,
    whatYouShouldKnow,
    whatYouMightBeMissing,
    opportunities,
    threatsAndChangedAssumptions,
    recommendedNextActions: dedupe(materialBriefs.flatMap((brief) => strings(brief.recommendations))),
    stillInvestigating,
    changedMindRecently,
    evidenceWouldChangeRecommendations,
  }
}
