import type { RichResult } from '@/lib/caye-direct-rich-results'

/** Server-authored semantic payload; neither the model nor client can set a URL. Mirrors ../rich-result.ts. */
export function engineeringAnalysisRichResult(analysisIds: readonly string[]): RichResult | undefined {
  const ids = [...new Set(analysisIds)]
  return ids.length ? { version: 1, narrative: 'Structural analysis ready.', blocks: ids.map((analysisId) => ({ type: 'engineering_analysis' as const, analysisId })) } : undefined
}
