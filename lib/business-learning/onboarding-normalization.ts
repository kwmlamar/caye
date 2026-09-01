import { createHash } from 'node:crypto'

export interface OnboardingTurn {
  question: string
  answer: string
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
}

function stableObjectEntries(value: unknown): OnboardingTurn[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  return Object.entries(value as Record<string, unknown>)
    .filter(([, answer]) => typeof answer === 'string' && clean(answer))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([question, answer]) => ({ question: clean(question), answer: clean(answer) }))
}

export function normalizeOnboardingTurns(
  rawAnswers: unknown,
  profile?: Record<string, unknown> | null
): OnboardingTurn[] {
  if (Array.isArray(rawAnswers)) {
    const turns = rawAnswers
      .map((item) => {
        if (!item || typeof item !== 'object') return null
        const row = item as Record<string, unknown>
        const question = clean(row.question)
        const answer = clean(row.answer)
        return question && answer ? { question, answer } : null
      })
      .filter((turn): turn is OnboardingTurn => Boolean(turn))
    if (turns.length) return turns
  }

  const objectTurns = stableObjectEntries(rawAnswers)
  if (objectTurns.length) return objectTurns

  return stableObjectEntries(profile).map((turn) => ({
    question: `Onboarding profile: ${turn.question}`,
    answer: turn.answer,
  }))
}

export function onboardingLearningContent(turns: OnboardingTurn[]): string {
  return turns
    .map((turn) => `Owner onboarding question: ${clean(turn.question)}\nOwner answer: ${clean(turn.answer)}`)
    .join('\n\n')
    .trim()
}

/**
 * The fingerprint is based on owner-provided knowledge, not completion time or
 * an LLM-synthesized profile. Exact retries, resumed completion, and backfill
 * therefore converge on the same observation. An edited answer produces a new
 * observation and lets the canonical property resolver handle supersession.
 */
export function onboardingSourceFingerprint(workspaceId: string, turns: OnboardingTurn[]): string {
  const canonical = JSON.stringify(
    turns.map((turn) => ({ question: clean(turn.question), answer: clean(turn.answer) }))
  )
  const digest = createHash('sha256').update(`${workspaceId}\n${canonical}`).digest('hex')
  return `owner_onboarding:v1:${digest}`
}

export function buildOwnerOnboardingObservation(input: {
  workspaceId: string
  rawAnswers: unknown
  profile?: Record<string, unknown> | null
  eventTime: string
  actorId?: string | null
  actorName?: string | null
  backfill?: boolean
}) {
  const turns = normalizeOnboardingTurns(input.rawAnswers, input.profile)
  const content = onboardingLearningContent(turns)
  const fingerprint = onboardingSourceFingerprint(input.workspaceId, turns)
  const actorId = clean(input.actorId) || clean(input.actorName) || null

  return {
    workspace_id: input.workspaceId,
    source_kind: 'owner_instruction',
    source_id: fingerprint,
    source_fingerprint: fingerprint,
    source_channel: 'onboarding',
    content,
    semantic_scope: 'customer_business',
    actor_type: 'owner',
    actor_id: actorId,
    event_time: input.eventTime,
    created_at: input.eventTime,
    source_metadata: {
      source: 'owner_instruction',
      provenance: 'onboarding',
      origin: 'owner_onboarding',
      semantic_scope: 'customer_business',
      authority_kind: 'owner_instruction',
      owner_explicit: true,
      owner_provided: true,
      actor_type: 'owner',
      actor_id: actorId,
      actor_name: clean(input.actorName) || null,
      event_time: input.eventTime,
      source_fingerprint: fingerprint,
      backfill: Boolean(input.backfill),
      normalization_version: 'owner-onboarding.v1',
    },
  }
}
