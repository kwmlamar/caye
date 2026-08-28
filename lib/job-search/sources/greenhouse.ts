/**
 * Job-search operator (#192) — Greenhouse public job-board adapter.
 *
 * Greenhouse's job-board API (boards-api.greenhouse.io) is a public,
 * unauthenticated, documented JSON endpoint intended for exactly this kind
 * of read: https://developers.greenhouse.io/job-board.html. This performs
 * a plain GET against it — no login, no scraping of authenticated pages,
 * no bypass of any access control. Config shape: { boards: string[] }
 * where each entry is a Greenhouse board token (the "exampleco" in
 * boards.greenhouse.io/exampleco).
 */
import type { RawJobPosting, RemoteType } from '../types'
import type { SourceAdapter } from './types'

type GreenhouseJob = {
  id: number
  title: string
  updated_at?: string
  absolute_url: string
  requisition_id?: string | null
  location?: { name?: string } | null
  content?: string | null
  offices?: { name?: string }[]
}

function stripHtml(html: string | null | undefined): string | null {
  if (!html) return null
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

function inferRemoteType(locationName: string | null | undefined): RemoteType {
  if (!locationName) return 'unknown'
  const lower = locationName.toLowerCase()
  if (lower.includes('remote')) return 'remote'
  if (lower.includes('hybrid')) return 'hybrid'
  return 'on_site'
}

async function fetchBoard(boardToken: string): Promise<RawJobPosting[]> {
  const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(boardToken)}/jobs?content=true`
  const res = await fetch(url, { headers: { accept: 'application/json' } })
  if (!res.ok) {
    throw new Error(`Greenhouse board "${boardToken}" fetch failed: ${res.status}`)
  }
  const body = (await res.json()) as { jobs?: GreenhouseJob[] }
  const jobs = body.jobs ?? []

  return jobs.map((job): RawJobPosting => {
    const locationName = job.location?.name ?? job.offices?.[0]?.name ?? null
    const description = stripHtml(job.content)
    return {
      sourceKey: 'greenhouse_public',
      sourceUrl: job.absolute_url,
      applyUrl: job.absolute_url,
      company: boardToken,
      title: job.title,
      requisitionId: job.requisition_id ?? null,
      location: locationName,
      remoteType: inferRemoteType(locationName),
      employmentType: null,
      salary: null,
      description,
      requirements: description,
      postedAt: job.updated_at ?? null,
    }
  })
}

export const greenhouseAdapter: SourceAdapter = {
  sourceKey: 'greenhouse_public',
  adapterType: 'greenhouse',
  async fetchCandidates(config) {
    const boards = Array.isArray((config as { boards?: unknown }).boards)
      ? ((config as { boards: unknown[] }).boards.filter((b): b is string => typeof b === 'string'))
      : []
    if (boards.length === 0) return []

    const results = await Promise.allSettled(boards.map(fetchBoard))
    return results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
  },
}
