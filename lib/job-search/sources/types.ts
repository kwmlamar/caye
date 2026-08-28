/**
 * Job-search operator (#192) — source adapter contract.
 *
 * A common interface every discovery source implements, so adding a new
 * compliant source (Ashby, Workday-style employer pages) is "write an
 * adapter satisfying this interface + register it in index.ts," not a
 * change to the ingest pipeline itself.
 *
 * Adapters are discovery-only. Nothing in this interface — or any
 * implementation of it — performs a submission action. That boundary
 * lives entirely in application-executor.ts.
 */
import type { RawJobPosting } from '../types'

export type SourceAdapter = {
  sourceKey: string
  adapterType: 'greenhouse' | 'lever' | 'ashby' | 'workday' | 'manual'
  /** Fetch currently-listed postings for this source's configured boards/sites. Read-only HTTP GET against a public API — never authenticates as a real user, never submits anything. */
  fetchCandidates: (config: Record<string, unknown>) => Promise<RawJobPosting[]>
}
