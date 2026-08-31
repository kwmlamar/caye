export const AI_GLOBAL_TECHNOLOGY_DESK = {
  id: 'ai-global-technology',
  domain: 'ai-and-global-technology',
  title: 'AI & Global Technology Intelligence',
  standingMission:
    'Continuously understand technological developments that could materially affect what becomes possible, what becomes commoditized, what should be built, what should stop being built, and where unusual opportunities are emerging.',
  cadence: {
    intervalHours: 6,
    reassessAfterMaterialChange: true,
  },
  explorationBudget: {
    maxInvestigationsPerCycle: 12,
    maxSourcesPerInvestigation: 12,
    reserveFractionForOutsideConsensus: 0.25,
  },
  standingAreas: [
    'OpenAI',
    'Anthropic',
    'Google/DeepMind',
    'Microsoft',
    'Meta',
    'Apple',
    'Amazon',
    'major startups',
    'open-source AI',
    'Chinese AI labs',
    'Chinese technology ecosystem',
    'robotics',
    'embodied AI',
    'agents',
    'computer use',
    'multimodal systems',
    'AI hardware',
    'inference',
    'model economics',
    'local models',
    'agent protocols (MCP, A2A, and successors)',
    'autonomous software engineering',
    'personal AI and JARVIS-style systems',
    'important research papers',
  ],
  standingQuestions: [
    'What became possible recently that was not realistically possible before?',
    'What capability is becoming dramatically cheaper?',
    'What previously difficult agent capability is becoming commodity infrastructure?',
    'What are frontier labs clearly building toward?',
    'What is China doing differently from the US?',
    'What important developments are occurring outside the US AI bubble?',
    'Which assumptions about agents/JARVIS are becoming obsolete?',
    'What should a builder stop implementing because providers are likely to commoditize it?',
    'What newly possible products/businesses exist because of recent advances?',
    'What developments materially change the timeline toward persistent personal AI or embodied intelligence?',
  ],
  sourcePolicy: {
    preferPrimary: true,
    requireIndependentCorroborationForHighConfidence: true,
    preserveContradictions: true,
    preferredKinds: ['primary', 'peer-reviewed', 'original-repo', 'independent'] as const,
    downrankKinds: ['community', 'unknown'] as const,
  },
  geographicScope: [
    'United States',
    'China',
    'Europe',
    'United Kingdom',
    'Canada',
    'Japan',
    'South Korea',
    'India',
    'Southeast Asia',
    'Middle East',
    'Africa',
    'Latin America',
    'global open-source communities',
  ],
  languageScope: ['English', 'Chinese (Simplified)', 'Chinese (Traditional)', 'Japanese', 'Korean'],
} as const

export type AiTechnologySourceKind =
  | 'primary'
  | 'peer-reviewed'
  | 'original-repo'
  | 'independent'
  | 'community'
  | 'unknown'

export type EvidenceStance = 'supports' | 'contradicts' | 'context'

export type AiTechnologyEvidence = {
  id: string
  url: string
  title?: string
  publisher?: string
  sourceKind: AiTechnologySourceKind
  independenceKey: string
  region: string
  language?: string
  publishedAt?: string
  observedAt: string
  stance: EvidenceStance
  summary: string
}

export type AiTechnologyDevelopmentCandidate = {
  /**
   * Semantic identity supplied by the research synthesizer. Multiple articles,
   * papers, posts, or mirrors describing the same underlying change MUST share
   * this key. The desk consolidates evidence; URLs are never intelligence IDs.
   */
  developmentKey: string
  title: string
  canonicalClaim: string
  themes: string[]
  standingQuestionIndexes: number[]
  materiality: {
    possibility: number
    commoditization: number
    builderDecision: number
    opportunity: number
    persistentAiTimeline: number
  }
  evidence: AiTechnologyEvidence[]
}

export type PreviousAiTechnologyBelief = {
  developmentKey: string
  confidence: number
  state: 'emerging' | 'supported' | 'contested' | 'weakening'
  lastSeen: string
}

export type AiTechnologyDevelopment = {
  developmentKey: string
  title: string
  canonicalClaim: string
  themes: string[]
  standingQuestions: string[]
  regions: string[]
  firstSeen: string
  lastSeen: string
  evidence: AiTechnologyEvidence[]
  sourceQuality: {
    primaryCount: number
    independentGroupCount: number
    highQualityCount: number
  }
  contradictions: AiTechnologyEvidence[]
  belief: {
    state: 'emerging' | 'supported' | 'contested' | 'weakening'
    confidence: number
    previousConfidence: number | null
    delta: number | null
  }
  materiality: AiTechnologyDevelopmentCandidate['materiality'] & { overall: number }
}

export type AiTechnologyTrend = {
  key: string
  label: string
  developmentKeys: string[]
  regions: string[]
  firstSeen: string
  lastSeen: string
  confidence: number
}

export type AiGlobalTechnologyIntelligence = {
  deskId: typeof AI_GLOBAL_TECHNOLOGY_DESK.id
  generatedAt: string
  developments: AiTechnologyDevelopment[]
  emergingTrends: AiTechnologyTrend[]
}

const SOURCE_WEIGHT: Record<AiTechnologySourceKind, number> = {
  primary: 0.95,
  'peer-reviewed': 0.92,
  'original-repo': 0.9,
  independent: 0.72,
  community: 0.42,
  unknown: 0.3,
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value))
}

function mean(values: number[]): number {
  if (!values.length) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function normalizedKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

function sourceTimestamp(evidence: AiTechnologyEvidence): number {
  return Date.parse(evidence.publishedAt ?? evidence.observedAt)
}

function sortEvidenceByQuality(evidence: AiTechnologyEvidence[]): AiTechnologyEvidence[] {
  return [...evidence].sort((a, b) => {
    const quality = SOURCE_WEIGHT[b.sourceKind] - SOURCE_WEIGHT[a.sourceKind]
    if (quality !== 0) return quality
    return sourceTimestamp(b) - sourceTimestamp(a)
  })
}

function confidenceFor(evidence: AiTechnologyEvidence[]): number {
  const supporting = evidence.filter((item) => item.stance === 'supports')
  const contradicting = evidence.filter((item) => item.stance === 'contradicts')
  if (!supporting.length) return contradicting.length ? 0.08 : 0.15

  const supportGroups = new Map<string, number>()
  for (const item of supporting) {
    supportGroups.set(
      item.independenceKey,
      Math.max(supportGroups.get(item.independenceKey) ?? 0, SOURCE_WEIGHT[item.sourceKind]),
    )
  }

  const contradictionGroups = new Map<string, number>()
  for (const item of contradicting) {
    contradictionGroups.set(
      item.independenceKey,
      Math.max(contradictionGroups.get(item.independenceKey) ?? 0, SOURCE_WEIGHT[item.sourceKind]),
    )
  }

  const strongest = Math.max(...supportGroups.values())
  const corroborationBoost = clamp((supportGroups.size - 1) * 0.08, 0, 0.2)
  const primaryBoost = supporting.some((item) => item.sourceKind === 'primary') ? 0.08 : 0
  const contradictionPenalty = clamp(
    [...contradictionGroups.values()].reduce((sum, value) => sum + value * 0.18, 0),
    0,
    0.45,
  )

  return Number(clamp(strongest * 0.72 + corroborationBoost + primaryBoost - contradictionPenalty, 0.05, 0.98).toFixed(3))
}

function overallMateriality(materiality: AiTechnologyDevelopmentCandidate['materiality']): number {
  return Number(
    mean([
      materiality.possibility,
      materiality.commoditization,
      materiality.builderDecision,
      materiality.opportunity,
      materiality.persistentAiTimeline,
    ]).toFixed(3),
  )
}

function combineMateriality(
  candidates: AiTechnologyDevelopmentCandidate[],
): AiTechnologyDevelopmentCandidate['materiality'] {
  const keys = ['possibility', 'commoditization', 'builderDecision', 'opportunity', 'persistentAiTimeline'] as const
  return Object.fromEntries(
    keys.map((key) => [key, Number(Math.max(...candidates.map((candidate) => candidate.materiality[key])).toFixed(3))]),
  ) as AiTechnologyDevelopmentCandidate['materiality']
}

function beliefState(
  confidence: number,
  contradictions: number,
  previous?: PreviousAiTechnologyBelief,
): AiTechnologyDevelopment['belief']['state'] {
  if (contradictions > 0 && confidence < 0.66) return 'contested'
  if (previous && confidence < previous.confidence - 0.15) return 'weakening'
  if (confidence >= 0.72) return 'supported'
  return 'emerging'
}

function consolidateDevelopment(
  candidates: AiTechnologyDevelopmentCandidate[],
  previous?: PreviousAiTechnologyBelief,
): AiTechnologyDevelopment {
  const representative = candidates[0]
  const evidence = sortEvidenceByQuality(
    [...new Map(candidates.flatMap((candidate) => candidate.evidence).map((item) => [item.id, item])).values()],
  )
  const timestamps = evidence.map(sourceTimestamp).filter(Number.isFinite)
  const confidence = confidenceFor(evidence)
  const contradictions = evidence.filter((item) => item.stance === 'contradicts')
  const materiality = combineMateriality(candidates)
  const standingQuestionIndexes = new Set(candidates.flatMap((candidate) => candidate.standingQuestionIndexes))
  const supportingGroups = new Set(
    evidence.filter((item) => item.stance === 'supports').map((item) => item.independenceKey),
  )

  return {
    developmentKey: representative.developmentKey,
    title: representative.title,
    canonicalClaim: representative.canonicalClaim,
    themes: [...new Set(candidates.flatMap((candidate) => candidate.themes.map(normalizedKey)))].sort(),
    standingQuestions: [...standingQuestionIndexes]
      .sort((a, b) => a - b)
      .map((index) => AI_GLOBAL_TECHNOLOGY_DESK.standingQuestions[index])
      .filter((question): question is (typeof AI_GLOBAL_TECHNOLOGY_DESK.standingQuestions)[number] => Boolean(question)),
    regions: [...new Set(evidence.map((item) => item.region))].sort(),
    firstSeen: new Date(Math.min(...timestamps)).toISOString(),
    lastSeen: new Date(Math.max(...timestamps)).toISOString(),
    evidence,
    sourceQuality: {
      primaryCount: evidence.filter((item) => item.sourceKind === 'primary').length,
      independentGroupCount: supportingGroups.size,
      highQualityCount: evidence.filter((item) => ['primary', 'peer-reviewed', 'original-repo', 'independent'].includes(item.sourceKind)).length,
    },
    contradictions,
    belief: {
      state: beliefState(confidence, contradictions.length, previous),
      confidence,
      previousConfidence: previous?.confidence ?? null,
      delta: previous ? Number((confidence - previous.confidence).toFixed(3)) : null,
    },
    materiality: { ...materiality, overall: overallMateriality(materiality) },
  }
}

export function detectAiTechnologyTrends(developments: AiTechnologyDevelopment[]): AiTechnologyTrend[] {
  const byTheme = new Map<string, AiTechnologyDevelopment[]>()
  for (const development of developments) {
    for (const theme of development.themes) {
      byTheme.set(theme, [...(byTheme.get(theme) ?? []), development])
    }
  }

  return [...byTheme.entries()]
    .filter(([, items]) => items.length >= 2)
    .map(([theme, items]) => {
      const regions = [...new Set(items.flatMap((item) => item.regions))].sort()
      const firstSeen = items.map((item) => Date.parse(item.firstSeen))
      const lastSeen = items.map((item) => Date.parse(item.lastSeen))
      const confidence = mean(items.map((item) => item.belief.confidence))
      const diversityBoost = Math.min(0.08, Math.max(0, regions.length - 1) * 0.02)
      return {
        key: theme,
        label: theme.replace(/-/g, ' '),
        developmentKeys: items.map((item) => item.developmentKey).sort(),
        regions,
        firstSeen: new Date(Math.min(...firstSeen)).toISOString(),
        lastSeen: new Date(Math.max(...lastSeen)).toISOString(),
        confidence: Number(clamp(confidence + diversityBoost, 0, 0.98).toFixed(3)),
      }
    })
    .sort((a, b) => b.confidence - a.confidence || a.key.localeCompare(b.key))
}

/**
 * Desk-specific semantic projection for the canonical research runtime.
 *
 * Persistence remains owned by Caye's research/intelligence substrate. This
 * function deliberately accepts already-observed evidence and returns stable,
 * JSON-safe intelligence suitable for a future canonical intelligence sink.
 */
export function compileAiGlobalTechnologyIntelligence(
  candidates: AiTechnologyDevelopmentCandidate[],
  previousBeliefs: PreviousAiTechnologyBelief[] = [],
  generatedAt = new Date().toISOString(),
): AiGlobalTechnologyIntelligence {
  const previousByKey = new Map(previousBeliefs.map((belief) => [belief.developmentKey, belief]))
  const groups = new Map<string, AiTechnologyDevelopmentCandidate[]>()

  for (const candidate of candidates) {
    const key = normalizedKey(candidate.developmentKey)
    if (!key) throw new Error('AI technology development requires a stable semantic developmentKey')
    groups.set(key, [...(groups.get(key) ?? []), { ...candidate, developmentKey: key }])
  }

  const developments = [...groups.entries()]
    .map(([key, grouped]) => consolidateDevelopment(grouped, previousByKey.get(key)))
    .sort((a, b) => b.materiality.overall - a.materiality.overall || b.belief.confidence - a.belief.confidence)

  return {
    deskId: AI_GLOBAL_TECHNOLOGY_DESK.id,
    generatedAt,
    developments,
    emergingTrends: detectAiTechnologyTrends(developments),
  }
}

export function buildAiGlobalTechnologySynthesisInstructions(): string {
  return [
    `You are the ${AI_GLOBAL_TECHNOLOGY_DESK.title} research desk.`,
    `Standing mission: ${AI_GLOBAL_TECHNOLOGY_DESK.standingMission}`,
    'Do not produce a news feed. Identify underlying technological developments. Ten reports about the same underlying change are one development with ten evidence records.',
    'Prefer first-party announcements, original papers/repos, standards, filings, benchmarks, and direct technical documentation. Use independent sources to corroborate material claims and preserve credible contradictions.',
    'Treat source repetition, syndicated stories, and outlets quoting the same upstream source as one independence group, not corroboration.',
    'Actively search outside the US. Include China and other regions when relevant, and distinguish genuinely independent regional evidence from English-language retellings.',
    'Track what changed over time, not merely what was published today. Explicitly identify belief-strengthening, belief-weakening, contradictions, and superseded assumptions.',
    'Every development must have a stable semantic developmentKey that would remain the same across follow-up runs about the same underlying change.',
    'Tag developments with themes and the zero-based standingQuestionIndexes they materially inform.',
    'Score materiality from 0 to 1 for possibility, commoditization, builderDecision, opportunity, and persistentAiTimeline.',
    `Standing questions:\n${AI_GLOBAL_TECHNOLOGY_DESK.standingQuestions.map((question, index) => `${index}. ${question}`).join('\n')}`,
    `Standing coverage areas:\n${AI_GLOBAL_TECHNOLOGY_DESK.standingAreas.join(', ')}`,
    `Geographic scope:\n${AI_GLOBAL_TECHNOLOGY_DESK.geographicScope.join(', ')}`,
    'Return machine-readable development candidates and evidence. Do not collapse contradictory evidence into a falsely certain narrative.',
  ].join('\n\n')
}
