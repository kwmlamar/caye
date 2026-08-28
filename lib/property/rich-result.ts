import type { RichResult } from '@/lib/caye-direct-rich-results'

export function propertySnapshotRichResult(propertyIds: readonly string[]): RichResult | undefined {
  const ids = [...new Set(propertyIds.filter(Boolean))]
  if (ids.length === 0) return undefined
  return {
    version: 1,
    narrative: '',
    blocks: ids.map((propertyId) => ({ type: 'property_snapshot' as const, propertyId })),
  }
}
