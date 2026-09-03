import 'server-only'
import {
  createBedrockAdapter,
  BedrockConnectionMissingError,
  type BedrockAdapter,
} from '@/lib/domain-adapters/bedrock'
import type { Tool } from '../types'

export interface FindJobInput {
  query: string
  include_completed?: boolean
}

export interface JobCandidate {
  id: string
  name: string
  status: string | null
  client_name: string | null
  location: string | null
}

export interface JobResolution {
  match: 'none' | 'one' | 'many'
  count: number
  candidates: JobCandidate[]
}

/**
 * Adapter surface find_job needs — and the surface get_job's name-resolution
 * path needs, since it calls the exact same {@link resolveJob}. A narrow
 * Pick rather than the full BedrockAdapter so tests can inject a one-method
 * fake instead of standing up the whole class.
 */
export type JobSearchAdapter = Pick<BedrockAdapter, 'listProjects'>

const ACTIVE_STATUSES = new Set(['active', 'planning', 'in_progress'])

// Filler words WhatsApp phrasing wraps the real search terms in — "the Mann
// job", "Eric's place", "the pool". Stripped so what's left is the part that
// actually identifies the project.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'job', 'jobs', 'place', 'project', 'for', 'at', 'of', 'on', 'in', 'and', 's',
])

function significantTokens(query: string): string[] {
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
  if (tokens.length > 0) return tokens
  // Every token was filler (or the query is a single short word like "s") —
  // fall back to the raw trimmed query rather than matching nothing.
  const fallback = query.trim().toLowerCase()
  return fallback ? [fallback] : []
}

/**
 * Resolve informal WhatsApp text ("Blue Sky", "the Mann job", "Christiansen",
 * "the pool") to zero, one, or several ODS TropiTrack projects.
 *
 * The read provider's own `search` option only ilikes `name` — it would
 * silently miss every client- or location-led query in the table above. So
 * this pulls the workspace's project list once and matches client-side
 * across name, client name, AND location: every significant token in the
 * query must appear somewhere in that combined text, in any field.
 *
 * Shared verbatim by find_job and get_job's `name` argument so the two tools
 * can never disagree about whether a phrase is unique — the failure mode
 * this exists to prevent is get_job silently resolving a name differently
 * than find_job would have surfaced it.
 */
export async function resolveJob(
  adapter: JobSearchAdapter,
  workspaceId: string,
  query: string,
  includeCompleted = false,
): Promise<JobResolution> {
  const tokens = significantTokens(query)
  if (tokens.length === 0) return { match: 'none', count: 0, candidates: [] }

  // Milestone-1 scale (one construction workspace): a single capped page
  // covers the whole active/planning project list. Revisit if ODS's project
  // count ever approaches the provider's 200-row cap.
  const rows = await adapter.listProjects(workspaceId, { limit: 200 })

  const matches = rows.filter((project) => {
    if (!includeCompleted) {
      const status = project.status?.toLowerCase() ?? null
      if (status && !ACTIVE_STATUSES.has(status)) return false
    }
    const haystack = `${project.name} ${project.clientNameSnapshot ?? ''} ${project.location ?? ''}`.toLowerCase()
    return tokens.every((t) => haystack.includes(t))
  })

  const candidates: JobCandidate[] = matches.map((p) => ({
    id: p.id,
    name: p.name,
    status: p.status,
    client_name: p.clientNameSnapshot,
    location: p.location,
  }))

  if (candidates.length === 0) return { match: 'none', count: 0, candidates: [] }
  if (candidates.length === 1) return { match: 'one', count: 1, candidates }
  return { match: 'many', count: candidates.length, candidates }
}

/**
 * Clean, non-alarming failure for the common case: most Caye workspaces have
 * no construction ledger connected at all. Shared with get_job so both tools
 * report the same thing the same way instead of one of them looking broken.
 */
export function bedrockConnectionErrorResult(): { ok: false; error: string } {
  return {
    ok: false,
    error:
      "This workspace isn't connected to a construction ledger (TropiTrack), so job/project lookups aren't " +
      'available here. Most Caye workspaces do not have one connected — this is expected unless the workspace ' +
      'was specifically set up for construction job costing.',
  }
}

export function makeFindJob(adapterFactory: () => JobSearchAdapter = createBedrockAdapter): Tool<FindJobInput> {
  return {
    name: 'find_job',
    description:
      'Resolve informal WhatsApp language ("Blue Sky", "the Mann job", "Christiansen", "the pool", "Parks") to ' +
      'an ODS TropiTrack construction project. Matches against project name, client name, AND location together ' +
      '— naming the client or the site finds the job even when nobody says the formal project name.\n\n' +
      "READ `match` FIRST, always, before doing anything with the result. 'one' -> exactly one candidate; safe " +
      "to use its id. 'many' -> several projects matched (a client with concurrent jobs, or a nickname that fits " +
      'several active sites) and there is deliberately NO single answer: list the candidates back to the person ' +
      "and ask which one — never guess, never pick the most recent or the first one. 'none' -> nothing matched; " +
      'ask for more detail, or retry with include_completed if the job might be finished. Attributing hours, ' +
      'materials, or cost to the wrong project silently corrupts job costing, which is the one thing this system ' +
      'exists to make trustworthy — treat an ambiguous match as a hard stop, not a nuisance.\n\n' +
      'Defaults to active/planning projects only; set include_completed to also search finished/cancelled jobs. ' +
      'Returns candidate summaries only (id, name, status, client, location) — call get_job with the resolved id ' +
      'for full project detail.',
    risk: 'read',
    roles: ['owner', 'staff', 'founder'],
    modes: ['back-office'],
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'What the caller said — a project name, client name, location, or informal nickname (e.g. "the ' +
            'pool", "Christiansen", "Blue Sky", "the Mann job").',
        },
        include_completed: {
          type: 'boolean',
          description: 'Default false (active/planning projects only). Set true to also search completed or cancelled jobs.',
        },
      },
      required: ['query'],
    },

    async execute(args, ctx) {
      const query = (args.query ?? '').trim()
      if (!query) return { ok: false, error: 'Empty query — give a project name, client name, or location to search for.' }

      try {
        const adapter = adapterFactory()
        const resolution = await resolveJob(adapter, ctx.workspaceId, query, args.include_completed === true)
        return { ok: true, data: { query, ...resolution } }
      } catch (err) {
        if (err instanceof BedrockConnectionMissingError) return bedrockConnectionErrorResult()
        return { ok: false, error: err instanceof Error ? err.message : 'Failed to search jobs.' }
      }
    },
  }
}

export const findJob: Tool<FindJobInput> = makeFindJob()
