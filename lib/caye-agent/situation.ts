import 'server-only'
import type Anthropic from '@anthropic-ai/sdk'
import { createServiceClient } from '@/lib/supabase-server'
import { fetchStandingRules, type StandingRule } from '@/lib/standing-rules'
import { fetchBusinessFacts, formatBusinessFactsBlock, type BusinessFactRow } from '@/lib/business-facts'
import { loadAttentionDelta, renderAttentionContext, type AttentionDelta } from '@/lib/owner-attention'

/**
 * situation.ts
 *
 * PHASE 1 of runtime convergence (see architectural autopsy, 2026-08-16).
 *
 * A deterministic assembler that loads what already exists in the database
 * into one typed `CayeSituation` — nothing here classifies, decides, or
 * writes. It is data loading and rendering, the same job `owner-attention.ts`
 * already does for the attention ledger, generalized to conversation timing,
 * relationship state, and work state.
 *
 * WHY THIS EXISTS
 * The audit found two concrete gaps that this closes:
 *   1. Timestamps are fetched from the database on every history load and
 *      then discarded before the model ever sees them (front-desk:
 *      `lib/conversation-history.ts`'s `HistoryEntry` has no timestamp field
 *      at all; back-office: `context.ts` uses `created_at` only as a query
 *      bound, never as rendered content). Whether a message thread is "an
 *      ongoing conversation" or "effectively a new one" is exactly the kind
 *      of judgment the model should make for itself — it cannot, without
 *      being shown elapsed time.
 *   2. Five relationship/work-state tables (`caye_relationships`,
 *      `caye_work_opportunities`, ...) were built 2026-08-14 and are
 *      write-only: something writes to them, nothing reads them back into
 *      a model's context. This assembler is the first reader.
 *
 * WHAT THIS DOES NOT DO
 *   - It does not call an LLM. Assembling the situation is pure retrieval +
 *     rendering, exactly like `renderAttentionContext` already is — the
 *     model decides what the facts mean, this only gathers the facts.
 *   - It does not grant authority. Relationship/work-state context here is
 *     read-only background a reasoning turn may use to understand a
 *     situation; it is never treated as permission to act. Execution
 *     authority is unchanged and lives entirely in the existing gates
 *     (`gateHighRisk`, `evidence.ts`, `sales/claims.ts`, etc.).
 *   - It does not fabricate relationship or work-opportunity state. Where
 *     no row exists, the corresponding field is `null`/`[]`, never invented.
 */

export type SituationChannel = 'back-office' | 'front-desk'

/**
 * Relative-time labels a model can reason from without doing date math.
 * Deliberately coarse and deliberately NOT a decision ("is this recent
 * enough to skip a greeting") — that judgment stays with the model. This
 * only renders the fact.
 */
export function relativeTimeLabel(fromISO: string, nowISO: string = new Date().toISOString()): string {
  const from = new Date(fromISO).getTime()
  const now = new Date(nowISO).getTime()
  if (!Number.isFinite(from) || !Number.isFinite(now)) return ''
  const deltaMs = now - from
  if (deltaMs < 0) return 'just now'

  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour

  if (deltaMs < 90 * 1000) return 'just now'
  if (deltaMs < hour) return `${Math.round(deltaMs / minute)} minutes ago`
  if (deltaMs < 2 * hour) return 'about an hour ago'
  if (deltaMs < day) return `${Math.round(deltaMs / hour)} hours ago`
  if (deltaMs < 2 * day) return 'yesterday'
  if (deltaMs < 7 * day) return `${Math.round(deltaMs / day)} days ago`

  const from_ = new Date(fromISO)
  return `on ${from_.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}`
}

/**
 * Annotate real human-authored turns with a leading relative-time marker.
 *
 * Scope, deliberately narrow: only `user`-role turns whose `content` is a
 * plain string get annotated — those are the turns a real person actually
 * typed (a customer's message, an operator's message). Turns whose content
 * is a content-block array (tool_use / tool_result turns, or a mixed
 * customer photo+caption turn) are left untouched: those are mechanical
 * continuations of the same live exchange, and inserting a text block ahead
 * of tool_result blocks risks the API's block-ordering contract for no
 * behavioral benefit — the surrounding plain-text turns already carry the
 * timing signal the model needs. This is a known, documented scope limit
 * (see architectural report §30), not an oversight.
 *
 * Pure function. Does not mutate its input; returns a new array.
 */
export function annotateHistoryWithRelativeTime(
  history: Anthropic.MessageParam[],
  timestamps: ReadonlyArray<string | null>,
  nowISO: string = new Date().toISOString()
): Anthropic.MessageParam[] {
  return history.map((turn, i) => {
    const at = timestamps[i] ?? null
    if (!at || turn.role !== 'user' || typeof turn.content !== 'string') return turn
    const label = relativeTimeLabel(at, nowISO)
    if (!label) return turn
    // Plain prose, no bracket/enum-shaped wrapper — deliberately matching
    // renderAttentionContext's convention (lib/owner-attention.ts), not a
    // stylistic accident. A model handed a bracketed token in its own
    // context window has been observed echoing it verbatim into a
    // customer/operator-facing reply (the "[operator_reminder]" incident
    // that convention exists to prevent); a plain leading clause carries
    // the same information without inviting that.
    return { ...turn, content: `${label} — ${turn.content}` }
  })
}

export interface RelationshipContext {
  relationshipId: string
  contactId: string | null
  state: 'prospect' | 'engaged' | 'client' | 'inactive'
  meaningfulInteractionStartedAt: string | null
  lastMeaningfulInteractionAt: string | null
}

export interface WorkOpportunityContext {
  id: string
  opportunityType: string
  description: string
  status: 'observed' | 'dismissed' | 'stale'
  confidence: 'medium' | 'high'
  lastEvidencedAt: string
}

export interface OperationalContext {
  standingRules: StandingRule[]
  businessFacts: BusinessFactRow[]
  /** Only loaded for back-office — front-desk replies don't compose
   *  proactive owner-facing summaries, so there is nothing to reconcile. */
  attentionDelta: AttentionDelta | null
}

export interface CayeSituation {
  channel: SituationChannel
  workspaceId: string
  now: string
  /** Real, ordered, multi-turn conversation — never flattened into one string. */
  history: Anthropic.MessageParam[]
  /** Index-aligned with `history`. Null where the source row had no known
   *  timestamp (legacy rows, synthetic turns). */
  historyTimestamps: (string | null)[]
  /**
   * `history` with relative-time markers applied to plain-string user turns.
   * Callers building a prompt should use this, not `history`, unless they
   * need the un-annotated form for persistence.
   */
  historyForModel: Anthropic.MessageParam[]
  /** Null when this conversation has no resolved `caye_relationships` row
   *  yet (the common case today — Phase 2 write path is new and narrow).
   *  Never fabricated. */
  relationship: RelationshipContext | null
  /** Empty when no relationship, or no opportunities recorded for one. */
  workOpportunities: WorkOpportunityContext[]
  operational: OperationalContext
}

/**
 * "TODAY'S DATE: 2026-08-16 (Saturday, August 16, 2026)." — an unambiguous
 * anchor for resolving relative/partial dates a customer or operator gives
 * ("Friday the 20th", "next Tuesday", "the 20th" with no month/year).
 *
 * WHY THIS EXISTS (2026-08-16, final pre-canary closure)
 * `situation.now` was already computed and used internally for relative-
 * time labels on history turns ("3 minutes ago") but the absolute current
 * date itself was never rendered anywhere in the prompt. A live replay
 * during this pass had the model resolve "Friday, November 20" (no year
 * given) to 2025 despite the situation's real `now` being 2026-08-16 —
 * not a hallucination so much as an absence: nothing in the prompt ever
 * told it what year it actually was, so it fell back to whatever its own
 * training data suggested. Both ISO and a spelled-out weekday/month form
 * are given — ISO for unambiguous machine-style date arithmetic, the
 * spelled-out form because "what day of the week is the 20th" is exactly
 * the kind of relative reasoning ("this Friday" vs "next Friday") this is
 * meant to make possible without the model doing its own calendar math
 * from a bare ISO string.
 */
export function todaysDateLabel(nowISO: string): string {
  const now = new Date(nowISO)
  if (Number.isNaN(now.getTime())) return ''
  const iso = nowISO.slice(0, 10)
  const spelled = now.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })
  return `TODAY'S DATE: ${iso} (${spelled}). Resolve any date the customer or operator gives — a day of week, "next Friday", a month/day with no year — relative to this, not from memory or assumption.`
}

/**
 * Render the non-conversational parts of a situation as a deterministic
 * prompt block — same posture as `renderAttentionContext`: facts, not
 * prose written by a model, and never treated as permission to act.
 */
export function renderSituationForPrompt(situation: CayeSituation): string {
  const lines: string[] = []
  const dateLabel = todaysDateLabel(situation.now)
  if (dateLabel) lines.push(dateLabel)

  if (situation.relationship) {
    const r = situation.relationship
    lines.push(
      `RELATIONSHIP STATE (read-only background, not an authorization): ${r.state}` +
        (r.lastMeaningfulInteractionAt
          ? `, last meaningful interaction ${relativeTimeLabel(r.lastMeaningfulInteractionAt, situation.now)}`
          : '') +
        (r.meaningfulInteractionStartedAt
          ? `, relationship started ${relativeTimeLabel(r.meaningfulInteractionStartedAt, situation.now)}`
          : '')
    )
  }

  if (situation.workOpportunities.length > 0) {
    lines.push('OPEN WORK OBSERVED FOR THIS RELATIONSHIP (background only — not an instruction to act on any of them):')
    for (const op of situation.workOpportunities) {
      lines.push(`  - ${op.description} (type: ${op.opportunityType}, confidence: ${op.confidence})`)
    }
  }

  const factsBlock = formatBusinessFactsBlock(situation.operational.businessFacts)
  if (factsBlock) lines.push(factsBlock)

  if (situation.operational.attentionDelta) {
    lines.push(renderAttentionContext(situation.operational.attentionDelta))
  }

  return lines.join('\n\n')
}

/**
 * Best-effort read of Phase 2/3 relationship + work-opportunity state for a
 * given contact. Both tables are new (2026-08-14) and thin today — most
 * calls will find nothing, which is expected and correctly rendered as
 * `null`/`[]` rather than an error.
 */
export async function loadRelationshipContext(
  workspaceId: string,
  contactId: string | null
): Promise<{ relationship: RelationshipContext | null; workOpportunities: WorkOpportunityContext[] }> {
  if (!contactId) return { relationship: null, workOpportunities: [] }

  const supabase = createServiceClient()
  const { data: relRow, error: relErr } = await supabase
    .from('caye_relationships')
    .select('id, contact_id, relationship_state, meaningful_interaction_started_at, last_meaningful_interaction_at')
    .eq('workspace_id', workspaceId)
    .eq('contact_id', contactId)
    .maybeSingle()

  if (relErr || !relRow) return { relationship: null, workOpportunities: [] }

  const relationship: RelationshipContext = {
    relationshipId: relRow.id as string,
    contactId: (relRow.contact_id as string | null) ?? null,
    state: relRow.relationship_state as RelationshipContext['state'],
    meaningfulInteractionStartedAt: (relRow.meaningful_interaction_started_at as string | null) ?? null,
    lastMeaningfulInteractionAt: (relRow.last_meaningful_interaction_at as string | null) ?? null,
  }

  const { data: workRows } = await supabase
    .from('caye_work_opportunities')
    .select('id, opportunity_type, description, status, confidence, last_evidenced_at')
    .eq('workspace_id', workspaceId)
    .eq('relationship_id', relationship.relationshipId)
    .eq('status', 'observed')
    .order('last_evidenced_at', { ascending: false })
    .limit(10)

  const workOpportunities: WorkOpportunityContext[] = (workRows ?? []).map((r) => ({
    id: r.id as string,
    opportunityType: r.opportunity_type as string,
    description: r.description as string,
    status: r.status as WorkOpportunityContext['status'],
    confidence: r.confidence as WorkOpportunityContext['confidence'],
    lastEvidencedAt: r.last_evidenced_at as string,
  }))

  return { relationship, workOpportunities }
}

/** Shared operational-context load (standing rules + business facts, and
 *  attention delta only for back-office). */
export async function loadOperationalContext(
  workspaceId: string,
  channel: SituationChannel
): Promise<OperationalContext> {
  const [standingRules, businessFacts, attentionDelta] = await Promise.all([
    fetchStandingRules(workspaceId),
    fetchBusinessFacts(workspaceId),
    channel === 'back-office' ? loadAttentionDelta({ workspaceId }) : Promise.resolve(null),
  ])
  return { standingRules, businessFacts, attentionDelta }
}
