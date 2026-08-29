/**
 * Job-search operator (#192) — cross-source dedup.
 *
 * A canonical_key must NOT rely on apply URL equality alone: the same real
 * posting frequently appears at different apply URLs across sources (a
 * Greenhouse posting mirrored on a company careers page, a Lever posting
 * re-listed with tracking params, etc). This normalizes company + title +
 * location + requisition id (when present) into one stable key so
 * job_search_candidates' unique(canonical_key) constraint is the actual
 * enforcement point for "same posting from multiple sources -> one
 * canonical candidate."
 */
import type { RawJobPosting } from './types'

function normalizeToken(value: string | null | undefined): string {
  if (!value) return ''
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\(.*?\)/g, ' ')
    // NFKD decomposes accented characters into base+combining-mark pairs;
    // stripping everything outside [a-z0-9] in one pass both removes the
    // combining marks and collapses punctuation, so "Café" and "Cafe"
    // converge without a separate Unicode-range regex.
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

/** Strips common seniority/location noise from a title so "Sr. Software Engineer II" and "Software Engineer 2" converge when the rest of the identity matches. */
function normalizeTitle(title: string): string {
  return normalizeToken(title)
    .replace(/\b(sr|senior|jr|junior|i|ii|iii|iv|1|2|3|4)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function computeCanonicalKey(posting: Pick<RawJobPosting, 'company' | 'title' | 'location' | 'requisitionId'>): string {
  const company = normalizeToken(posting.company)
  const title = normalizeTitle(posting.title)
  const location = normalizeToken(posting.location)
  const requisition = normalizeToken(posting.requisitionId ?? null)

  // Requisition id, when present, is the strongest identity signal — a
  // company changing a title's wording shouldn't split one requisition
  // into two candidates.
  if (requisition) return `req:${company}:${requisition}`
  return `ct:${company}:${title}:${location}`
}
