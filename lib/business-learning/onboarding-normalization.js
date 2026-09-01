import { createHash } from 'node:crypto'

function clean(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
}

function stableObjectEntries(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  return Object.entries(value)
    .filter(([, answer]) => typeof answer === 'string' && clean(answer))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([question, answer]) => ({ question: clean(question), answer: clean(answer) }))
}

/**
 * Normalize every persisted onboarding representation into the same ordered
 * owner-answer turns used by live onboarding.
 *
 * @param {unknown} rawAnswers
 * @param {Record<string, unknown> | null | undefined} profile
 * @returns {{ question: string, answer: string }[]}
 */
export function normalizeOnboardingTurns(rawAnswers, profile) {
  if (Array.isArray(rawAnswers)) {
    const turns = rawAnswers
      .map((item) => {
        if (!item || typeof item !== 'object') return null
        const row = /** @type {Record<string, unknown>} */ (item)
        const question = clean(row.question)
        const answer = clean(row.answer)
        return question && answer ? { question, answer } : null
      })
      .filter(Boolean)
    if (turns.length) return /** @type {{question:string, answer:string}[]} */ (turns)
  }

  const objectTurns = stableObjectEntries(rawAnswers)
  if (objectTurns.length) return objectTurns

  return stableObjectEntries(profile).map((turn) => ({
    question: `Onboarding profile: ${turn.question}`,
    answer: turn.answer,
  }))
}

/** @param {{question:string, answer:string}[]} turns */
export function onboardingLearningContent(turns) {
  return turns
    .map((turn) => `Owner onboarding question: ${clean(turn.question)}\nOwner answer: ${clean(turn.answer)}`)
    .join('\n\n')
    .trim()
}

/**
 * Fingerprint is intentionally based on owner-provided answers, not the LLM
 * synthesized profile or completion timestamp. Retrying the same completion,
 * resuming it, or replaying backfill therefore reaches the same observation.
 * Editing an answer creates a new observation whose canonical properties are
 * resolved by the normal conflict/supersession pipeline.
 *
 * @param {string} workspaceId
 * @param {{question:string, answer:string}[]} turns
 */
export function onboardingSourceFingerprint(workspaceId, turns) {
  const canonical = JSON.stringify(
    turns.map((turn) => ({ question: clean(turn.question), answer: clean(turn.answer) }))
  )
  const digest = createHash('sha256').update(`${workspaceId}\n${canonical}`).digest('hex')
  return `owner_onboarding:v1:${digest}`
}

/**
 * @param {{workspaceId:string, rawAnswers:unknown, profile?:Record<string,unknown>|null, eventTime:string, actorId?:string|null, actorName?:string|null, backfill?:boolean}} input
 */
export function buildOwnerOnboardingObservation(input) {
  const turns = normalizeOnboardingTurns(input.rawAnswers, input.profile)
  const content = onboardingLearningContent(turns)
  const fingerprint = onboardingSourceFingerprint(input.workspaceId, turns)
  return {
    workspace_id: input.workspaceId,
    source_kind: 'owner_onboarding',
    source_id: fingerprint,
    source_fingerprint: fingerprint,
    source_channel: 'onboarding',
    content,
    semantic_scope: 'customer_business',
    actor_type: 'owner',
    actor_id: input.actorId ?? input.workspaceId,
    event_time: input.eventTime,
    // The canonical pipeline currently uses created_at for temporal conflict
    // resolution. Preserve historical onboarding time there as well as in the
    // explicit event_time column so stale backfill cannot outrank a correction.
    created_at: input.eventTime,
    source_metadata: {
      source: 'onboarding',
      origin: 'owner_onboarding',
      semantic_scope: 'customer_business',
      authority: 'configured_business_source',
      owner_provided: true,
      actor_type: 'owner',
      actor_id: input.actorId ?? input.workspaceId,
      actor_name: input.actorName ?? null,
      event_time: input.eventTime,
      source_fingerprint: fingerprint,
      backfill: Boolean(input.backfill),
      normalization_version: 'owner-onboarding.v1',
    },
  }
}
