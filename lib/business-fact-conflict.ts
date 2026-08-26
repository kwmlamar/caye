import 'server-only'
import Anthropic from '@anthropic-ai/sdk'
import { loggedMessagesCreate } from '@/lib/llm-telemetry'
import { sharesAnyWord } from '@/lib/business-fact-semantic-match'

/**
 * CAY-14. Production incident: an older fact ("payments are made in advance
 * by card only... cash and Zelle are not accepted") stayed active after the
 * owner's policy moved on. add_business_fact only ever appended — nothing
 * ever marked the earlier fact retired — so Caye told a guest cash wasn't
 * accepted, the owner had to correct that live in the conversation, and the
 * delay contributed to losing the booking.
 *
 * This is the judge that runs before a new owner-taught fact is saved: does
 * it contradict something already active, and if so, is it a clean
 * replacement (supersede the old one) or genuinely unclear which applies
 * (fail closed, ask the owner)? Same small-LLM-call shape as
 * findSemanticFactMatch (business-fact-semantic-match.ts) — that judge asks
 * "is this the SAME fact reworded", this one asks "does this fact
 * CONTRADICT an existing one" — deliberately kept as two separate judges
 * rather than one prompt doing both jobs, since conflating "duplicate" and
 * "contradiction" would blur the exact distinction this exists to make.
 */

export interface ActiveFact {
  id: string
  text: string
  /** business_facts.source of the existing row. */
  source: string
  /**
   * Optional human-readable scope annotation ("workspace-wide" / "specific
   * to <Service Name>"), added after the 2026-08-26 historical-learning
   * audit found a real, still-unresolved case in production: a
   * service-scoped fact ("the Heritage Tour meeting point is the pink
   * building by the dock") and a later workspace-wide fact ("the pickup
   * location for all tours is the Casino Tram Stop") both stayed active —
   * bare fact text alone gives the judge no way to reason about whether a
   * general claim actually overrides a specific one. Optional and additive:
   * existing callers (add-business-fact.ts, confirm-fact-candidate.ts) that
   * don't pass it see identical behavior to before this field existed.
   */
  scopeLabel?: string
}

export type ConflictResolution = 'supersede' | 'ambiguous'

export interface ConflictCheckResult {
  conflictId: string | null
  resolution: ConflictResolution | null
  /**
   * True when a conflict check was actually needed (there were plausible
   * candidates) but the judge call itself failed — model/network error, or
   * an unparseable response. Distinct from "no conflict": callers MUST treat
   * this as fail-closed, the same as an 'ambiguous' resolution, because we
   * genuinely don't know whether the new fact contradicts an active one.
   */
  checkFailed?: boolean
}

const MAX_CANDIDATES = 25

const NO_CONFLICT: ConflictCheckResult = { conflictId: null, resolution: null }
const CHECK_FAILED: ConflictCheckResult = { conflictId: null, resolution: null, checkFailed: true }

/**
 * Provenance rank used to decide whether a new fact is ALLOWED to supersede
 * a conflicting one. 'owner-direct' and 'escalation-capture' are both the
 * owner speaking directly (live-taught vs. captured from an escalation
 * response) and rank equally; 'candidate-confirmed' is Caye's own inference
 * from a repeated pattern that the owner merely approved, one step removed
 * from an explicit owner statement — the "inferred / model-generated
 * knowledge" rule 3 says owner-direct corrections must outrank.
 */
const SOURCE_RANK: Record<string, number> = {
  'owner-direct': 2,
  'escalation-capture': 2,
  'candidate-confirmed': 1,
}

export function factSourceRank(source: string): number {
  return SOURCE_RANK[source] ?? 0
}

/** Does a fact from `newSource` outrank (or tie) one from `oldSource`? */
export function outranksForSupersession(newSource: string, oldSource: string): boolean {
  return factSourceRank(newSource) >= factSourceRank(oldSource)
}

/**
 * Judges whether `newFact` contradicts one of `active`. Returns
 * { conflictId: null, resolution: null } when there's no real conflict —
 * the common case, and the only one that lets the new fact save
 * independently alongside what's already there.
 *
 * Unlike findSemanticFactMatch's fail-open-on-infra-error stance, this judge
 * fails CLOSED on an infra error whenever there was something worth checking
 * (`plausible.length > 0`): a duplicate-detection miss just means a fact gets
 * saved twice, but a conflict-detection miss can silently recreate the exact
 * CAY-14 incident — an old and a new contradictory fact both left active
 * because "couldn't check" was treated as "no conflict". When there is
 * nothing plausible to conflict with, the LLM is never called and this
 * correctly returns no-conflict — that path carries no risk to fail open on.
 * See `checkFailed` on the result: callers must treat it exactly like
 * 'ambiguous' (do not save, ask the owner / retry) rather than proceeding as
 * if nothing was found.
 */
export async function findConflictingFact(
  newFact: string,
  active: ActiveFact[],
  ctx: { workspaceId: string; source: string; newFactScopeLabel?: string }
): Promise<ConflictCheckResult> {
  if (active.length === 0) return NO_CONFLICT

  const plausible = active.filter((f) => sharesAnyWord(newFact, f.text)).slice(0, MAX_CANDIDATES)
  if (plausible.length === 0) return NO_CONFLICT

  try {
    const client = new Anthropic()
    const list = plausible
      .map((f, i) => `${i + 1}. [${f.id}]${f.scopeLabel ? ` (${f.scopeLabel})` : ''} ${f.text}`)
      .join('\n')
    const newFactLine = ctx.newFactScopeLabel ? `New fact (${ctx.newFactScopeLabel}): "${newFact}"` : `New fact: "${newFact}"`

    const message = await loggedMessagesCreate(
      client,
      {
        model: 'claude-sonnet-4-6',
        max_tokens: 200,
        system:
          'You judge whether a NEW business fact CONTRADICTS an existing one — describes the ' +
          'business operating differently on the same specific topic (same policy, same rule, ' +
          'same detail), not merely a different but compatible fact about a related topic. Two ' +
          'facts about different services, different guest segments, or different time periods ' +
          'are NOT a conflict even if topically similar.\n\n' +
          'Some facts carry a scope annotation in parentheses ("workspace-wide" or "specific to ' +
          '<Service Name>"). Use it explicitly: a workspace-wide claim CAN genuinely conflict with ' +
          'a service-specific one on the same topic (e.g. a new "pickup for all tours is at X" ' +
          'claim against an existing "the Heritage Tour meets at Y" fact, if X and Y are actually ' +
          'different places) — scope difference alone does not mean "not a conflict"; you still ' +
          'have to judge whether the general claim, taken at face value, actually contradicts the ' +
          'specific one. When you cannot tell whether they describe the same real-world thing (e.g. ' +
          'you cannot tell if two named locations are the same place), that uncertainty is exactly ' +
          'what "ambiguous" is for — do not guess.\n\n' +
          'If you find a real contradiction, also judge how to resolve it:\n' +
          '- "supersede": the new fact plainly states the business now does things differently — ' +
          'a correction or updated policy that fully replaces the old one, with nothing indicating ' +
          'the old statement could still apply in some situation.\n' +
          '- "ambiguous": you cannot tell whether the new fact fully replaces the old one, or the ' +
          'two could both be true depending on context (different circumstances, a partial change, ' +
          'unclear scope). When genuinely unsure between supersede and ambiguous, choose ambiguous ' +
          '— a wrong "ambiguous" costs one clarifying question to the owner; a wrong "supersede" ' +
          'silently hides a fact that was still true.\n\n' +
          'When there is no real contradiction, return null for both fields — do not flag ' +
          'unrelated or merely-additional facts.\n\n' +
          'Return ONLY valid JSON, no markdown: {"conflict_id": "string or null", "resolution": ' +
          '"supersede" or "ambiguous" or null}',
        messages: [
          {
            role: 'user',
            content: `${newFactLine}\n\nExisting facts:\n${list}`,
          },
        ],
      },
      { source: ctx.source, workspaceId: ctx.workspaceId }
    )

    const raw = message.content[0].type === 'text' ? message.content[0].text : ''
    const text = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()
    const parsed = JSON.parse(text) as { conflict_id: string | null; resolution: ConflictResolution | null }

    if (!parsed.conflict_id) return NO_CONFLICT
    // Only trust an id the model actually saw — never let a hallucinated id through.
    const matched = plausible.some((f) => f.id === parsed.conflict_id)
    if (!matched) return NO_CONFLICT

    // A conflict_id with no valid resolution is a malformed response, not a
    // "no conflict" — fail closed rather than silently letting a flagged
    // contradiction through as if nothing was found.
    const resolution: ConflictResolution =
      parsed.resolution === 'supersede' || parsed.resolution === 'ambiguous' ? parsed.resolution : 'ambiguous'

    return { conflictId: parsed.conflict_id, resolution }
  } catch (err) {
    // plausible.length > 0 here (the guard above already returned NO_CONFLICT
    // otherwise) — there was something worth checking and the check itself
    // failed, so this must fail closed, not silently report no conflict.
    console.error('[business-fact-conflict] conflict check failed against plausible candidates, failing closed:', err)
    return CHECK_FAILED
  }
}
