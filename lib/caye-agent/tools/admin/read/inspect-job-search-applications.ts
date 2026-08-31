import 'server-only'
import type { Tool } from '../../types'
import { createServiceClient } from '@/lib/supabase-server'
import { inspectApplicationForHumanAssist, runJobSearchInspection } from '@/app/api/caye/job-search-inspect/route'
import { recordJobSearchAnswer } from '../write-low/record-job-search-answer'

type Input = {
  application_id?: string
  candidate_id?: string
  company?: string
  title?: string
  question?: string
  answer?: string
}

type CandidateApplicationRow = {
  id: string
  status: string
  updated_at: string
  candidate: { company: string; title: string } | null
}

async function resolveApplicationId(args: Input): Promise<string | null> {
  const supabase = createServiceClient()

  if (args.application_id) {
    const { data: exact, error: exactError } = await supabase
      .from('job_search_applications')
      .select('id')
      .eq('id', args.application_id)
      .maybeSingle()
    if (exactError) throw new Error(`Could not resolve application: ${exactError.message}`)
    if (exact?.id) return exact.id as string

    // Caye previously confused candidate IDs with application IDs in chat. Treat
    // that as a resolvable identifier mismatch rather than a dead-end retry loop.
    const { data: byCandidate, error: candidateError } = await supabase
      .from('job_search_applications')
      .select('id')
      .eq('candidate_id', args.application_id)
      .order('updated_at', { ascending: false })
      .limit(2)
    if (candidateError) throw new Error(`Could not resolve candidate application: ${candidateError.message}`)
    if ((byCandidate ?? []).length === 1) return byCandidate![0].id as string
  }

  if (args.candidate_id) {
    const { data: byCandidate, error } = await supabase
      .from('job_search_applications')
      .select('id')
      .eq('candidate_id', args.candidate_id)
      .order('updated_at', { ascending: false })
      .limit(2)
    if (error) throw new Error(`Could not resolve candidate application: ${error.message}`)
    if ((byCandidate ?? []).length === 1) return byCandidate![0].id as string
    if ((byCandidate ?? []).length > 1) throw new Error('Multiple applications exist for that candidate. Use the exact application_id.')
  }

  if (args.company) {
    let query = supabase
      .from('job_search_applications')
      .select('id,status,updated_at,candidate:job_search_candidates!inner(company,title)')
      .ilike('candidate.company', args.company.trim())
      .order('updated_at', { ascending: false })
      .limit(10)

    if (args.title?.trim()) query = query.ilike('candidate.title', `%${args.title.trim()}%`)

    const { data, error } = await query
    if (error) throw new Error(`Could not resolve company application: ${error.message}`)
    const rows = (data ?? []) as unknown as CandidateApplicationRow[]
    if (rows.length === 1) return rows[0].id

    const prepared = rows.filter((row) => row.status === 'PREPARED')
    if (prepared.length === 1) return prepared[0].id
    if (rows.length > 1) {
      const matches = rows.slice(0, 5).map((row) => `${row.candidate?.company ?? 'unknown'} · ${row.candidate?.title ?? 'unknown'} · ${row.status}`).join('; ')
      throw new Error(`Multiple job applications match that selector. Narrow it with title or application_id. Matches: ${matches}`)
    }
  }

  return null
}

/**
 * Founder-only, no-submission inspection of job applications.
 *
 * Caye can resolve a review target from application_id, candidate_id, or a
 * company/title selector. This matters in normal conversation because the
 * founder should not need to know internal UUIDs just to review a queued job.
 *
 * This tool never submits or contacts an employer.
 */
export const inspectJobSearchApplications: Tool<Input> = {
  name: 'inspect_job_search_applications',
  description:
    'Inspect founder job applications and resolve Greenhouse readiness. Prefer natural selectors: use company (and title when helpful) when the founder names a job, or application_id/candidate_id when already known. The tool resolves the canonical application itself, including PREPARED applications. If the founder has answered an unresolved required question, include the selector plus the exact question text and explicit answer to persist it and re-inspect. With no arguments, inspect current NEEDS_HUMAN applications. Never invent an application UUID. This tool never submits or contacts an employer.',
  risk: 'read',
  roles: ['founder'],
  modes: ['admin-shell', 'back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      application_id: { type: 'string', description: 'Exact canonical job_search_applications ID when already known. Do not guess.' },
      candidate_id: { type: 'string', description: 'Exact job_search_candidates ID when already known.' },
      company: { type: 'string', description: 'Company name from the founder request, e.g. ScaleOps.' },
      title: { type: 'string', description: 'Optional job title used to disambiguate company matches.' },
      question: { type: 'string' },
      answer: { type: 'string' },
    },
  },

  async execute(args, ctx) {
    try {
      const hasSelector = Boolean(args.application_id || args.candidate_id || args.company)
      const hasQuestion = Boolean(args.question)
      const hasAnswer = Boolean(args.answer)

      if (hasQuestion !== hasAnswer) {
        return { ok: false, error: 'question and answer must be supplied together when recording an answer.' }
      }

      if (!hasSelector && (hasQuestion || hasAnswer)) {
        return { ok: false, error: 'Provide application_id, candidate_id, or company when recording an application answer.' }
      }

      if (hasSelector) {
        const applicationId = await resolveApplicationId(args)
        if (!applicationId) {
          return { ok: false, error: 'Application not found from the supplied selector. Use company/title from the queued job or an exact known application_id; do not invent an ID.' }
        }

        if (hasQuestion && hasAnswer) {
          return recordJobSearchAnswer.execute(
            { application_id: applicationId, question: args.question!, answer: args.answer! },
            ctx,
          )
        }

        const result = await inspectApplicationForHumanAssist(applicationId)
        return { ok: true, data: result }
      }

      const result = await runJobSearchInspection()
      return { ok: true, data: result }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not inspect job-search applications' }
    }
  },
}
