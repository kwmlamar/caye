import 'server-only'
import Anthropic from '@anthropic-ai/sdk'
import { loggedMessagesCreate } from '@/lib/llm-telemetry'
import { normalizeSentence } from '@/lib/business-fact-candidate-detection'

/**
 * Why this exists: business_fact_candidates has never produced a single fact.
 * normalizeSentence's exact-string dedup — a deliberate choice to keep false-merges at
 * zero — means two sentences expressing the same fact in different words never
 * collapse into one row. Confirmed from real Bimini data: "Meeting Point: Resorts
 * World Bimini Casino Tram Stop" and "...please take the complimentary Resorts World
 * Bimini tram from the pier to the Casino Tram Stop" filed as two separate,
 * unmerged, permanently-stuck-at-occurrence-1 candidates. See
 * briefs/cold-start-plan.md.
 *
 * This is the semantic fallback: only reached when the free exact-match fast path
 * (normalizeSentence equality) misses. Judges whether a new sentence expresses the
 * same underlying fact as something already known — an existing candidate or a
 * confirmed business_facts row — so it can be merged instead of filed as a
 * duplicate.
 */

export interface KnownFact {
  id: string
  text: string
}

export interface SemanticMatchResult {
  matchId: string | null
}

const MAX_CANDIDATES = 25

/**
 * Cheap pre-filter: word-overlap floor before spending an LLM call. Not a
 * substitute for the LLM judgment (word overlap is a poor proxy for "same fact" —
 * it's exactly the mechanism business-fact-suggestions.ts's old overlapsExistingFact
 * used, at a 60% threshold, and it's too crude to trust as a final answer). Its only
 * job is trimming an unbounded existing-facts list down to plausible candidates
 * before asking the model to choose among them.
 */
export function sharesAnyWord(a: string, b: string): boolean {
  const wordsA = new Set(normalizeSentence(a).split(' ').filter((w) => w.length > 3))
  if (wordsA.size === 0) return true // nothing to filter on — let the LLM see it
  return normalizeSentence(b)
    .split(' ')
    .some((w) => w.length > 3 && wordsA.has(w))
}

/**
 * Judges whether `sentence` expresses the same underlying fact as one of `known`.
 * Returns the matched id, or null if it's genuinely new.
 *
 * Deliberately a single small LLM call per new sentence rather than embeddings or
 * vector search — at this scale (single digits of candidates/facts per workspace,
 * confirmed against prod: Bimini has 14 facts and 8 all-time candidates) a full
 * list fits trivially in one prompt, and this stays consistent with this codebase's
 * existing pattern for small structured-JSON decisions (lib/onboarding.ts's
 * decideNextDiscoveryStep).
 */
export async function findSemanticFactMatch(
  sentence: string,
  known: KnownFact[],
  ctx: { workspaceId: string; source: string }
): Promise<SemanticMatchResult> {
  if (known.length === 0) return { matchId: null }

  const plausible = known.filter((k) => sharesAnyWord(sentence, k.text)).slice(0, MAX_CANDIDATES)
  if (plausible.length === 0) return { matchId: null }

  try {
    const client = new Anthropic()
    const list = plausible.map((k, i) => `${i + 1}. [${k.id}] ${k.text}`).join('\n')

    const message = await loggedMessagesCreate(
      client,
      {
        model: 'claude-sonnet-4-6',
        max_tokens: 200,
        system:
          'You judge whether a new sentence expresses the SAME underlying fact as one already on a ' +
          'list, even if worded completely differently. Same fact = same real-world thing being ' +
          'stated (same meeting point, same policy, same rule) — not just topically related. ' +
          '"The pickup is at the tram stop" and "meet us at the Casino Tram Stop" are the same fact. ' +
          '"Refunds take 30 days" and "refunds require further investigation" are NOT the same fact ' +
          'even though both are about refunds. When genuinely unsure, prefer "no match" — a missed ' +
          'merge just means two rows instead of one; a false merge silently loses information.\n\n' +
          'Return ONLY valid JSON, no markdown: {"match_id": "string or null"}',
        messages: [
          {
            role: 'user',
            content: `New sentence: "${sentence}"\n\nExisting facts:\n${list}`,
          },
        ],
      },
      { source: ctx.source, workspaceId: ctx.workspaceId }
    )

    const raw = message.content[0].type === 'text' ? message.content[0].text : ''
    const text = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()
    const parsed = JSON.parse(text) as { match_id: string | null }

    if (!parsed.match_id) return { matchId: null }
    // Only trust an id the model actually saw — never let a hallucinated id through.
    const valid = plausible.some((k) => k.id === parsed.match_id)
    return { matchId: valid ? parsed.match_id : null }
  } catch (err) {
    // No match beats a bad match — a merge failure at worst produces one extra
    // pending candidate; a bad merge silently conflates two different facts.
    console.error('[business-fact-semantic-match] match failed, treating as new:', err)
    return { matchId: null }
  }
}
