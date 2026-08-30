import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { Tool } from '../../types'

interface ListJobSearchCandidatesInput {
  limit?: number
  status?: 'DISCOVERED' | 'SCORED' | 'REJECTED' | 'QUEUED' | 'HUMAN_REVIEW'
  run_id?: string
  latest_source_run?: boolean
}

/**
 * Founder observability over either the cumulative scored pool or one exact
 * sourcing run. Run-scoped reads use job_search_run_candidates snapshots so
 * later rescoring/upserts cannot rewrite what an earlier run actually saw.
 */
export const listJobSearchCandidates: Tool<ListJobSearchCandidatesInput> = {
  name: 'list_job_search_candidates',
  description:
    'Inspect job-search candidates. By default this returns the best candidates across the cumulative scored pool. Set latest_source_run=true to inspect ONLY the exact candidates captured by the most recent sourcing run, or pass run_id for a specific run. Run-scoped results preserve the score/status/source snapshot from that run.',
  risk: 'read',
  roles: ['founder'],
  modes: ['admin-shell', 'back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Maximum candidates to return, 1-50. Defaults to 20.' },
      status: {
        type: 'string',
        enum: ['DISCOVERED', 'SCORED', 'REJECTED', 'QUEUED', 'HUMAN_REVIEW'],
        description: 'Optional status filter.',
      },
      run_id: {
        type: 'string',
        description: 'Optional exact job_search_runs UUID. When provided, return only snapshots from that run.',
      },
      latest_source_run: {
        type: 'boolean',
        description: 'When true, resolve the most recent completed source run and return only candidates captured by that run.',
      },
    },
  },

  async execute(args) {
    const supabase = createServiceClient()
    const limit = Math.max(1, Math.min(50, Math.floor(args.limit ?? 20)))

    if (args.run_id || args.latest_source_run) {
      let runId = args.run_id?.trim() || null
      let run: Record<string, unknown> | null = null

      if (!runId) {
        const { data: latestRun, error: runError } = await supabase
          .from('job_search_runs')
          .select('id, run_type, status, started_at, completed_at, stats, error')
          .eq('run_type', 'source')
          .eq('status', 'completed')
          .order('completed_at', { ascending: false })
          .limit(1)
          .maybeSingle()
        if (runError) return { ok: false, error: runError.message }
        if (!latestRun) return { ok: true, data: { run: null, candidates: [], note: 'No completed sourcing run exists yet.' } }
        runId = latestRun.id as string
        run = latestRun as Record<string, unknown>
      } else {
        const { data: exactRun, error: runError } = await supabase
          .from('job_search_runs')
          .select('id, run_type, status, started_at, completed_at, stats, error')
          .eq('id', runId)
          .maybeSingle()
        if (runError) return { ok: false, error: runError.message }
        if (!exactRun) return { ok: false, error: `Job-search run ${runId} was not found.` }
        run = exactRun as Record<string, unknown>
      }

      let snapshotQuery = supabase
        .from('job_search_run_candidates')
        .select('candidate_id, canonical_key, company, title, location, remote_type, posted_at, apply_url, source_keys, discovered_via, fit_score, status, bucket, score_explanation, rejection_reasons, hard_block_reason, recorded_at')
        .eq('run_id', runId)
        .order('fit_score', { ascending: false, nullsFirst: false })
        .order('recorded_at', { ascending: false })
        .limit(limit)

      if (args.status) snapshotQuery = snapshotQuery.eq('status', args.status)
      const { data, error } = await snapshotQuery
      if (error) return { ok: false, error: error.message }

      return {
        ok: true,
        data: {
          run,
          candidates: data ?? [],
          exact_run_snapshot: true,
          note: (data?.length ?? 0) === 0
            ? 'This run has no candidate snapshots. Runs completed before run-level observability was deployed cannot be reconstructed exactly; run sourcing again to create an exact snapshot.'
            : 'These are exact snapshots from this sourcing run. Later candidate updates do not change these run-scoped score/status/source results.',
        },
      }
    }

    let query = supabase
      .from('job_search_candidates')
      .select('id, company, title, location, remote_type, status, fit_score, score_explanation, rejection_reasons, hard_block_reason, apply_url, posted_at, discovered_at, discovered_via, updated_at')
      .not('fit_score', 'is', null)
      .order('fit_score', { ascending: false })
      .order('updated_at', { ascending: false })
      .limit(limit)

    if (args.status) query = query.eq('status', args.status)

    const { data, error } = await query
    if (error) return { ok: false, error: error.message }

    return {
      ok: true,
      data: {
        candidates: data ?? [],
        exact_run_snapshot: false,
        note: 'These rows are the cumulative current candidate pool, not a specific sourcing run. Being surfaced here does not bypass policy gates or promote a candidate into the application queue.',
      },
    }
  },
}
