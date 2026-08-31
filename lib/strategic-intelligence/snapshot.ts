import 'server-only'

import { getAllCurrentClaims, getLatestBriefs, getResearchStatus } from '@/lib/research/runtime'
import { sanitizeStrategicHumanOutput } from './presentation'

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

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
  const [claims, briefs, programs] = await Promise.all([
    getAllCurrentClaims(),
    getLatestBriefs(),
    getResearchStatus(),
  ])
  const nowMs = now.getTime()
  const freshBriefs = briefs.filter((brief) => isFresh(brief.created_at, nowMs))
  const materialBriefs = freshBriefs.filter(isMaterialBrief)

  const strongestBeliefs = claims
    .filter((claim) => claim.status === 'current' || claim.status === 'contested')
    .filter((claim) => !claim.valid_until || Date.parse(claim.valid_until) > nowMs)
    .map((claim) => ({
      statement: clean(String(claim.statement ?? '')),
      confidence: typeof claim.confidence === 'number' ? claim.confidence : claim.confidence == null ? null : Number(claim.confidence),
      contested: claim.status === 'contested' || (claim.research_claim_evidence ?? []).some((edge: { stance?: string }) => edge.stance === 'contradicts'),
    }))
    .filter((claim) => claim.statement.length > 0)
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
    .slice(0, 12)

  const whatChanged = dedupe(materialBriefs.flatMap((brief) => strings(brief.material_changes)))
  const whatYouShouldKnow = dedupe(materialBriefs.map((brief) => String(brief.current_understanding ?? '')))
  const opportunities = dedupe(materialBriefs.flatMap((brief) => [
    ...strings(brief.recommendations),
    ...strings(brief.implications),
  ]))
  const threatsAndChangedAssumptions = dedupe(materialBriefs.flatMap((brief) => strings(brief.conflicting_evidence)))
  const changedMindRecently = dedupe([
    ...materialBriefs.flatMap((brief) => strings(brief.conflicting_evidence)),
    ...strongestBeliefs.filter((claim) => claim.contested).map((claim) => `Evidence is contesting: ${claim.statement}`),
  ])
  const evidenceWouldChangeRecommendations = dedupe(materialBriefs.flatMap((brief) => strings(brief.unknowns)))

  const stillInvestigating = dedupe(programs.flatMap((program) =>
    (program.research_questions ?? [])
      .filter((question: { status?: string }) => question.status === 'open' || question.status === 'researching')
      .map((question: { question?: string }) => String(question.question ?? ''))
  ), 20)

  // Wildcard/cross-domain work lands in the same canonical brief substrate. Until
  // a dedicated semantic projection is merged, implications that are not merely
  // repeats of material changes are the safest evidence-backed approximation.
  const changedKeys = new Set(whatChanged.map((item) => item.toLowerCase()))
  const whatYouMightBeMissing = dedupe(
    materialBriefs.flatMap((brief) => strings(brief.implications)).filter((item) => !changedKeys.has(clean(item).toLowerCase())),
  )

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
