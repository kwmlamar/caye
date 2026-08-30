import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'
import { prepareApplication } from '@/lib/job-search/application-executor'
import { getJobSearchSettings } from '@/lib/job-search/settings'
import { getRemainingDailyCapacity } from '@/lib/job-search/queue'

const POSTGRES_UNIQUE_VIOLATION = '23505'

type ResumeVariantRow = {
  id: string
  variant_key: 'it_support' | 'full_stack' | 'backend_platform' | 'ai_llm'
  title: string
  summary: string | null
  sections: Record<string, unknown>
  status: 'needs_verification' | 'verified'
}

type CandidateRow = {
  id: string
  company: string
  title: string
  apply_url: string
  skills: string[] | null
  fit_score: number | null
}

function chooseVariant(candidate: CandidateRow, variants: ResumeVariantRow[]): ResumeVariantRow | null {
  const haystack = `${candidate.title} ${(candidate.skills ?? []).join(' ')}`.toLowerCase()
  const preferredKey = /\b(technical support|it support|help ?desk|service desk|support engineer|support specialist|support technician|support representative|frontline support|l1 support|tier 1 support)\b/.test(haystack)
    ? 'it_support'
    : /\b(ai|llm|machine learning|ml|artificial intelligence)\b/.test(haystack)
      ? 'ai_llm'
      : /\b(backend|platform|api|database|infrastructure|server)\b/.test(haystack)
        ? 'backend_platform'
        : 'full_stack'
  return variants.find((variant) => variant.variant_key === preferredKey)
    ?? variants.find((variant) => variant.variant_key === 'full_stack')
    ?? variants[0]
    ?? null
}

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (secret) {
    const auth = request.headers.get('authorization')
    const legacy = request.headers.get('x-cron-secret')
    if (auth !== `Bearer ${secret}` && legacy !== secret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  try {
    const stats = await runJobSearchPreparation()
    return NextResponse.json({ status: 'completed', stats })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

export async function runJobSearchPreparation(): Promise<Record<string, unknown>> {
  const supabase = createServiceClient()
  const settings = await getJobSearchSettings()
  if (settings.paused) return { skippedPaused: true, prepared: 0 }

  const remainingCapacity = await getRemainingDailyCapacity()
  if (remainingCapacity <= 0) return { skippedDailyCap: true, prepared: 0, remainingCapacity: 0 }

  const { data: runRow, error: runError } = await supabase
    .from('job_search_runs')
    .insert({ run_type: 'apply', status: 'running', run_trigger_source: 'cron' })
    .select('id')
    .single()

  if (runError || !runRow) {
    if (runError?.code === POSTGRES_UNIQUE_VIOLATION) {
      return { skippedAlreadyRunning: true, prepared: 0, remainingCapacity }
    }
    throw new Error(`Could not start job-search preparation run: ${runError?.message}`)
  }

  const runId = runRow.id as string
  const stats = {
    prepared: 0,
    needsHuman: 0,
    prohibitedPlatform: 0,
    skippedUnverified: 0,
    errors: [] as string[],
    remainingCapacity,
  }

  try {
    const { data: variants, error: variantsError } = await supabase
      .from('job_search_resume_variants')
      .select('id,variant_key,title,summary,sections,status')
      .eq('is_active', true)
      .eq('status', 'verified')
    if (variantsError) throw new Error(variantsError.message)
    const verifiedVariants = (variants ?? []) as ResumeVariantRow[]
    if (verifiedVariants.length === 0) throw new Error('No verified active resume variants found')

    const { data: candidates, error: candidatesError } = await supabase
      .from('job_search_candidates')
      .select('id,company,title,apply_url,skills,fit_score')
      .eq('status', 'QUEUED')
      .gte('fit_score', settings.minimumQueueScore)
      .order('fit_score', { ascending: false })
      .order('posted_at', { ascending: false })
      .limit(Math.max(remainingCapacity * 5, 25))
    if (candidatesError) throw new Error(candidatesError.message)

    const candidateRows = (candidates ?? []) as CandidateRow[]
    if (candidateRows.length === 0) {
      await supabase.from('job_search_runs').update({ status: 'completed', completed_at: new Date().toISOString(), stats }).eq('id', runId)
      return stats
    }

    const candidateIds = candidateRows.map((candidate) => candidate.id)
    const { data: existingApplications, error: existingError } = await supabase
      .from('job_search_applications')
      .select('candidate_id')
      .in('candidate_id', candidateIds)
    if (existingError) throw new Error(existingError.message)
    const existing = new Set((existingApplications ?? []).map((row) => row.candidate_id as string))
    const freshCandidates = candidateRows.filter((candidate) => !existing.has(candidate.id)).slice(0, remainingCapacity)

    for (const candidate of freshCandidates) {
      const variant = chooseVariant(candidate, verifiedVariants)
      if (!variant) {
        stats.errors.push(`${candidate.company} / ${candidate.title}: no resume variant`)
        continue
      }
      try {
        const result = await prepareApplication(
          {
            id: candidate.id,
            company: candidate.company,
            title: candidate.title,
            applyUrl: candidate.apply_url,
            skills: Array.isArray(candidate.skills) ? candidate.skills : [],
            // ATS-specific field discovery happens later at the execution/review boundary.
            // This preparation pass never invents answers or claims it submitted anything.
            requiredFields: [],
          },
          {
            id: variant.id,
            variantKey: variant.variant_key,
            title: variant.title,
            summary: variant.summary,
            sections: variant.sections ?? {},
            status: variant.status,
          },
        )
        if (result.outcome === 'needs_human') {
          stats.prepared++
          stats.needsHuman++
        } else if (result.outcome === 'prohibited_platform') {
          stats.prepared++
          stats.prohibitedPlatform++
        } else if (result.outcome === 'skipped_unverified_source') {
          stats.skippedUnverified++
        }
      } catch (err) {
        stats.errors.push(`${candidate.company} / ${candidate.title}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    await supabase.from('job_search_runs').update({ status: 'completed', completed_at: new Date().toISOString(), stats }).eq('id', runId)
    return stats
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await supabase.from('job_search_runs').update({ status: 'failed', completed_at: new Date().toISOString(), error: message, stats }).eq('id', runId)
    throw err
  }
}
