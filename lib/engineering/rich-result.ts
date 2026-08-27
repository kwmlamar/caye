import type { RichResult } from '@/lib/caye-direct-rich-results'

/** Server-authored semantic payload; neither the model nor client can set a URL. */
export function engineeringRichResult(artifactIds: readonly string[]): RichResult | undefined {
  const ids = [...new Set(artifactIds)]
  return ids.length ? { version: 1, narrative: 'Engineering artifact ready.', blocks: ids.map((artifactId) => ({ type: 'engineering_artifact' as const, artifactId })) } : undefined
}
