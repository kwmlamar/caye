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

type LeverPosting = {
  id: string
  text: string
  hostedUrl: string
  applyUrl?: string
  createdAt?: number
  descriptionPlain?: string | null
  categories?: { location?: string; team?: string; commitment?: string } | null
  workplaceType?: string | null
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

async function fetchSite(siteSlug: string): Promise<RawJobPosting[]> {
  const url = `https://api.lever.co/v0/postings/${encodeURIComponent(siteSlug)}?mode=json`
  const res = await fetch(url, { headers: { accept: 'application/json' } })
  if (!res.ok) {
    throw new Error(`Lever site "${siteSlug}" fetch failed: ${res.status}`)
  }
  const postings = (await res.json()) as LeverPosting[]

  return postings.map((posting): RawJobPosting => ({
    sourceKey: 'lever_public',
    sourceUrl: posting.hostedUrl,
    applyUrl: posting.applyUrl ?? posting.hostedUrl,
    company: siteSlug,
    title: posting.text,
    requisitionId: posting.id,
    location: posting.categories?.location ?? null,
    remoteType: inferRemoteType(posting),
    employmentType: posting.categories?.commitment ?? null,
    salary: null,
    description: posting.descriptionPlain ?? null,
    requirements: posting.descriptionPlain ?? null,
    postedAt: posting.createdAt ? new Date(posting.createdAt).toISOString() : null,
  }))
}

export const leverAdapter: SourceAdapter = {
  sourceKey: 'lever_public',
  adapterType: 'lever',
  async fetchCandidates(config) {
    const sites = Array.isArray((config as { sites?: unknown }).sites)
      ? ((config as { sites: unknown[] }).sites.filter((s): s is string => typeof s === 'string'))
      : []
    if (sites.length === 0) return []

    const results = await Promise.allSettled(sites.map(fetchSite))
    return results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
  },
}
