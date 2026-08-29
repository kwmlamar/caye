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

export type SourceFetchResult = {
  postings: RawJobPosting[]
  /**
   * Per-board/site failures that would otherwise be silently swallowed.
   * Both adapters fan out across multiple boards/sites via
   * Promise.allSettled so one bad board doesn't lose every other board's
   * postings — but a naive "just flatMap the fulfilled ones" discards the
   * rejection reasons entirely, so a typo'd board token or a renamed
   * Lever site produces zero postings forever with no signal anywhere
   * (audited 2026-08-28, PR #196). Callers (ingest.ts) fold these into
   * stats.errors / job_search_events instead.
   */
  errors: string[]
}

export type SourceAdapter = {
  sourceKey: string
  adapterType: 'greenhouse' | 'lever' | 'ashby' | 'workday' | 'manual'
  /** Fetch currently-listed postings for this source's configured boards/sites. Read-only HTTP GET against a public API — never authenticates as a real user, never submits anything. */
  fetchCandidates: (config: Record<string, unknown>) => Promise<SourceFetchResult>
}
