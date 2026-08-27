import type { RichResult, RichResultBlock } from '@/lib/caye-direct-rich-results'

/**
 * Server-authored semantic payload for business artifacts crossing into Caye
 * Direct — mirrors lib/engineering/rich-result.ts exactly. Only an artifact
 * id crosses the chat boundary; neither the model nor the client can set a
 * URL (see caye-direct-rich-results.ts's validateRichResult, which rejects
 * a model-authored 'business_artifact' block outright). The actual signed
 * URL is minted per-request by app/api/founder/business-artifacts/[id]/route.ts,
 * after that route re-verifies workspace ownership itself.
 */
export function businessArtifactRichResult(artifactIds: readonly string[]): RichResult | undefined {
  const ids = [...new Set(artifactIds)]
  return ids.length
    ? { version: 1, narrative: '', blocks: ids.map((artifactId) => ({ type: 'business_artifact' as const, artifactId })) }
    : undefined
}

/**
 * Merges two server-authored RichResults into one — needed because a single
 * founder turn can in principle produce both an engineering artifact
 * (create_parametric_part) and a business artifact (retrieve_artifact_for_
 * operator). Prefers `a`'s narrative when both are non-empty; concatenates
 * blocks. Returns whichever side is defined when the other is not.
 */
export function mergeRichResults(a: RichResult | undefined, b: RichResult | undefined): RichResult | undefined {
  if (!a) return b
  if (!b) return a
  return { version: 1, narrative: a.narrative || b.narrative, blocks: [...a.blocks, ...b.blocks] }
}
