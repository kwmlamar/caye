/**
 * Job-search operator (#192) — Lever public postings adapter.
 *
 * Public unauthenticated postings feed. Config supports:
 * { sites: string[], maxAgeDays?: number, titleTerms?: string[] }
 * maxAgeDays defaults to 30 so stale postings do not pollute active scoring.
 * titleTerms is an optional case-insensitive relevance prefilter.
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

function buildFullText(posting: LeverPosting): string {
  const parts = [posting.descriptionPlain ?? '']
  for (const section of posting.lists ?? []) {
    const stripped = stripHtml(section.content)
    if (stripped) parts.push(stripped)
  }
  return parts.filter(Boolean).join('\n\n')
}

function isFresh(posting: LeverPosting, maxAgeDays: number, now = Date.now()): boolean {
  if (!posting.createdAt) return true
  const ageMs = now - posting.createdAt
  if (ageMs < 0) return true
  return ageMs <= maxAgeDays * 24 * 60 * 60 * 1000
}

function matchesTitleTerms(posting: LeverPosting, titleTerms: string[]): boolean {
  if (titleTerms.length === 0) return true
  const title = posting.text.toLowerCase()
  return titleTerms.some((term) => title.includes(term.toLowerCase()))
}

async function fetchSite(siteSlug: string, maxAgeDays: number, titleTerms: string[]): Promise<RawJobPosting[]> {
  const url = `https://api.lever.co/v0/postings/${encodeURIComponent(siteSlug)}?mode=json`
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`Lever site "${siteSlug}" fetch failed: ${res.status}`)
  const postings = (await res.json()) as LeverPosting[]

  return postings
    .filter((posting) => isFresh(posting, maxAgeDays) && matchesTitleTerms(posting, titleTerms))
    .map((posting): RawJobPosting => {
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
        requirements: fullText || null,
        postedAt: posting.createdAt ? new Date(posting.createdAt).toISOString() : null,
      }
    })
}

export const leverAdapter: SourceAdapter = {
  sourceKey: 'lever_public',
  adapterType: 'lever',
  async fetchCandidates(config) {
    const raw = config as { sites?: unknown; maxAgeDays?: unknown; titleTerms?: unknown }
    const sites = Array.isArray(raw.sites) ? raw.sites.filter((s): s is string => typeof s === 'string') : []
    if (sites.length === 0) return { postings: [], errors: [] }

    const configuredAge = typeof raw.maxAgeDays === 'number' && Number.isFinite(raw.maxAgeDays) ? raw.maxAgeDays : 30
    const maxAgeDays = Math.max(1, Math.min(90, configuredAge))
    const titleTerms = Array.isArray(raw.titleTerms)
      ? raw.titleTerms.filter((term): term is string => typeof term === 'string' && term.trim().length > 0)
      : []

    const results = await Promise.allSettled(sites.map((site) => fetchSite(site, maxAgeDays, titleTerms)))
    const postings = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
    const errors = results
      .map((r, i) => (r.status === 'rejected' ? `lever site "${sites[i]}": ${r.reason instanceof Error ? r.reason.message : String(r.reason)}` : null))
      .filter((e): e is string => e !== null)
    return { postings, errors }
  },
}
