/**
 * Job-search operator (#192) — Lever public postings adapter.
 *
 * api.lever.co/v0/postings/{site}?mode=json is Lever's public, documented,
 * unauthenticated postings feed: https://github.com/lever/postings-api.
 * Plain GET, no login, no scraping of authenticated pages. Config shape:
 * { sites: string[] } where each entry is a Lever site slug (the
 * "exampleco" in jobs.lever.co/exampleco).
 */
import type { RawJobPosting, RemoteType } from '../types'
import type { SourceAdapter } from './types'
import { stripHtml } from './html-text'

type LeverPosting = {
  id: string
  text: string
  hostedUrl: string
  applyUrl?: string
  createdAt?: number
  descriptionPlain?: string | null
  // Verified live against api.lever.co/v0/postings/{site} (2026-08-28):
  // descriptionPlain is ONLY the opening company blurb — the substantive
  // sections ("What You'll Do", "Requirements", "Nice to Have",
  // "Compensation", etc, exactly where citizenship/clearance/OPT/
  // years-of-experience language conventionally lives) are in this
  // separate `lists` array as HTML, not inside descriptionPlain at all.
  // The original adapter only read descriptionPlain for `requirements`,
  // which meant detectWorkAuthSignals never saw the actual requirements
  // text for any Lever-sourced posting.
  lists?: { text?: string; content?: string }[] | null
  categories?: { location?: string; team?: string; commitment?: string } | null
  workplaceType?: string | null
  salaryRange?: { min?: number; max?: number; currency?: string } | null
}

function inferRemoteType(posting: LeverPosting): RemoteType {
  const workplace = (posting.workplaceType ?? '').toLowerCase()
  if (workplace.includes('remote')) return 'remote'
  if (workplace.includes('hybrid')) return 'hybrid'
  if (workplace.includes('on')) return 'on_site'
  const location = (posting.categories?.location ?? '').toLowerCase()
  if (location.includes('remote')) return 'remote'
  return 'unknown'
}

/**
 * Builds the full scannable text for a posting: the intro blurb plus every
 * `lists` section's content, concatenated. Deliberately includes ALL
 * sections (not just one literally titled "Requirements") — companies
 * name sections inconsistently ("Qualifications", "What We're Looking
 * For", "Eligibility") and a work-authorization/clearance disclaimer can
 * land in any of them (even "Compensation" or "Interviewing with X"
 * sections sometimes carry one) — policy-gate.ts's own contract is "the
 * full text, not a truncated excerpt."
 */
function buildFullText(posting: LeverPosting): string {
  const parts = [posting.descriptionPlain ?? '']
  for (const section of posting.lists ?? []) {
    const stripped = stripHtml(section.content)
    if (stripped) parts.push(stripped)
  }
  return parts.filter(Boolean).join('\n\n')
}

async function fetchSite(siteSlug: string): Promise<RawJobPosting[]> {
  const url = `https://api.lever.co/v0/postings/${encodeURIComponent(siteSlug)}?mode=json`
  // A hung connection to one site must not stall the whole sourcing run.
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) })
  if (!res.ok) {
    throw new Error(`Lever site "${siteSlug}" fetch failed: ${res.status}`)
  }
  const postings = (await res.json()) as LeverPosting[]

  return postings.map((posting): RawJobPosting => {
    const fullText = buildFullText(posting)
    return {
      sourceKey: 'lever_public',
      sourceUrl: posting.hostedUrl,
      applyUrl: posting.applyUrl ?? posting.hostedUrl,
      company: siteSlug,
      title: posting.text,
      requisitionId: posting.id,
      location: posting.categories?.location ?? null,
      remoteType: inferRemoteType(posting),
      employmentType: posting.categories?.commitment ?? null,
      salary: posting.salaryRange
        ? { min: posting.salaryRange.min, max: posting.salaryRange.max, currency: posting.salaryRange.currency }
        : null,
      description: posting.descriptionPlain ?? null,
      // Full text (intro + every lists[] section, HTML-stripped) — the
      // fix for the gap described in the LeverPosting.lists doc comment
      // above.
      requirements: fullText || null,
      postedAt: posting.createdAt ? new Date(posting.createdAt).toISOString() : null,
    }
  })
}

export const leverAdapter: SourceAdapter = {
  sourceKey: 'lever_public',
  adapterType: 'lever',
  async fetchCandidates(config) {
    const sites = Array.isArray((config as { sites?: unknown }).sites)
      ? ((config as { sites: unknown[] }).sites.filter((s): s is string => typeof s === 'string'))
      : []
    if (sites.length === 0) return { postings: [], errors: [] }

    const results = await Promise.allSettled(sites.map(fetchSite))
    const postings = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
    const errors = results
      .map((r, i) => (r.status === 'rejected' ? `lever site "${sites[i]}": ${r.reason instanceof Error ? r.reason.message : String(r.reason)}` : null))
      .filter((e): e is string => e !== null)
    return { postings, errors }
  },
}
