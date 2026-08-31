export type EpistemicKind =
  | 'observed_live'
  | 'durable_memory'
  | 'explicit_human'
  | 'inference'
  | 'prediction'
  | 'unknown'
  | 'validated_learning'

export interface EpistemicEvidence {
  label: string
  value: string
  kind: EpistemicKind
  confidence?: number | null
  observedAt?: string | null
  expiresAt?: string | null
  sourceLabel?: string | null
  contradictedBy?: string[]
  supersedes?: string[]
  environment?: 'simulated' | 'branch' | 'test' | 'production' | null
}

export interface EpistemicSummary {
  known: string[]
  inferred: string[]
  predictions: string[]
  unknown: string[]
  stale: string[]
  conflicts: string[]
  rendered: string
}

const KIND_LABEL: Record<EpistemicKind, string> = {
  observed_live: 'Observed live',
  durable_memory: 'Remembered',
  explicit_human: 'Human-provided',
  inference: 'Inferred',
  prediction: 'Prediction',
  unknown: 'Unknown',
  validated_learning: 'Validated lesson',
}

function certainty(confidence?: number | null): string {
  if (confidence == null) return 'certainty unknown'
  const pct = Math.round(Math.max(0, Math.min(1, confidence)) * 100)
  return `${pct}% confidence`
}

function isStale(item: EpistemicEvidence, now: Date): boolean {
  if (!item.expiresAt) return false
  const expires = Date.parse(item.expiresAt)
  return Number.isFinite(expires) && expires <= now.getTime()
}

function safeKind(item: EpistemicEvidence): EpistemicKind {
  // Simulated, branch, and test evidence are evidence about those environments.
  // They are never allowed to masquerade as a live production observation.
  if (item.kind === 'observed_live' && item.environment && item.environment !== 'production') {
    return 'inference'
  }
  return item.kind
}

function humanLine(item: EpistemicEvidence, kind: EpistemicKind): string {
  const source = item.sourceLabel ? `; source: ${item.sourceLabel}` : ''
  const environment = item.environment ? `; environment: ${item.environment}` : ''
  return `${KIND_LABEL[kind]}: ${item.label}: ${item.value} (${certainty(item.confidence)}${source}${environment})`
}

/**
 * Turns already-retrieved facts into an operator-facing evidence summary without
 * leaking row IDs, table names, or provenance blobs. Retrieval and authority
 * remain owned by the existing memory/observation systems; this only preserves
 * their epistemic labels at presentation time.
 */
export function summarizeEpistemicEvidence(items: EpistemicEvidence[], now = new Date()): EpistemicSummary {
  const known: string[] = []
  const inferred: string[] = []
  const predictions: string[] = []
  const unknown: string[] = []
  const stale: string[] = []
  const conflicts: string[] = []

  for (const item of items) {
    const kind = safeKind(item)
    const line = humanLine(item, kind)
    if (isStale(item, now)) {
      stale.push(`${line}; stale since ${item.expiresAt}`)
    } else if (kind === 'inference') {
      inferred.push(line)
    } else if (kind === 'prediction') {
      predictions.push(line)
    } else if (kind === 'unknown') {
      unknown.push(line)
    } else {
      known.push(line)
    }

    if (item.contradictedBy?.length) {
      conflicts.push(`${item.label} has ${item.contradictedBy.length} contradictory validated source${item.contradictedBy.length === 1 ? '' : 's'}.`)
    }
  }

  const sections: string[] = []
  if (known.length) sections.push(`What I know\n${known.map(v => `- ${v}`).join('\n')}`)
  if (inferred.length) sections.push(`What I infer\n${inferred.map(v => `- ${v}`).join('\n')}`)
  if (predictions.length) sections.push(`Predictions\n${predictions.map(v => `- ${v}`).join('\n')}`)
  if (unknown.length) sections.push(`What is unknown\n${unknown.map(v => `- ${v}`).join('\n')}`)
  if (stale.length) sections.push(`Stale evidence\n${stale.map(v => `- ${v}`).join('\n')}`)
  if (conflicts.length) sections.push(`Conflicts\n${conflicts.map(v => `- ${v}`).join('\n')}`)

  return { known, inferred, predictions, unknown, stale, conflicts, rendered: sections.join('\n\n') }
}

/** Human statements retain authority over derived learning. */
export function chooseAuthoritativeEvidence(items: EpistemicEvidence[]): EpistemicEvidence | null {
  if (!items.length) return null
  const authorityRank: Record<EpistemicKind, number> = {
    explicit_human: 6,
    observed_live: 5,
    durable_memory: 4,
    validated_learning: 3,
    inference: 2,
    prediction: 1,
    unknown: 0,
  }
  return [...items].sort((a, b) => {
    const authority = authorityRank[safeKind(b)] - authorityRank[safeKind(a)]
    if (authority !== 0) return authority
    return (b.confidence ?? 0) - (a.confidence ?? 0)
  })[0]
}
