/**
 * Job-search operator (#192) — sourcing/normalize/dedupe/score orchestrator.
 *
 * This is the DB-touching glue layer. All the decision logic it calls
 * (computeCanonicalKey, detectWorkAuthSignals, scoreCandidate,
 * evaluatePolicyGate) is pure and unit-tested independently — this module
 * is deliberately thin so a real Postgres integration test isn't required
 * to trust the parts that matter (dedup correctness, hard-blocker
 * enforcement, scoring). Called by the job-search-sourcing cron route.
 */
import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { computeCanonicalKey } from './dedupe'
import { detectWorkAuthSignals } from './policy-gate'
import { getActiveProfile } from './profile'
import { scoreCandidate } from './scoring'
import { getSourceAdapter } from './sources'
import { logJobSearchEvent } from './events'
import type { RawJobPosting } from './types'

export type IngestRunStats = {
  sourced: number
  deduped: number
  scored: number
  autoQueued: number
  queuedIfCapacity: number
  reviewLowPriority: number
  rejected: number
  errors: string[]
  /** True when this call was a no-op because a 'source' run was already in flight — see job_search_runs_one_running_per_type_idx. */
  skippedAlreadyRunning?: boolean
}

/** Postgres unique_violation. See job_search_runs_one_running_per_type_idx in the migration. */
const POSTGRES_UNIQUE_VIOLATION = '23505'

type YearsRequirement = { years: number | null; isHardRequirement: boolean }

// Bounded lookahead window after a years-of-experience match — long enough
// to catch "5 years experience preferred" / "5+ years is a plus" style
// phrasing immediately following the number, short enough that an
// unrelated "preferred" elsewhere in a long posting can't soften a
// mention it has nothing to do with.
const SOFT_QUALIFIER_WINDOW_CHARS = 40
const SOFT_QUALIFIER_PATTERN = /\b(?:preferred|nice to have|a plus|ideally?|bonus|desired|not required)\b/i

/**
 * Extracts the years-of-experience figure from a posting's requirements
 * text, and whether that figure reads as a strict minimum ("5 years
 * required") vs a soft preference ("5 years preferred", "5+ years is a
 * plus"). Audited 2026-08-28 (PR #196): the original version always
 * treated any years mention as a hard minimum, which meant an "8+ years
 * preferred" posting — soft language that doesn't actually rule out an
 * early-career candidate — got hard-blocked by the >5-year junior-target
 * threshold exactly the same as an actual "8+ years required" posting.
 */
function parseYearsRequired(requirements: string | null): YearsRequirement {
  if (!requirements) return { years: null, isHardRequirement: true }
  const match = requirements.match(/(\d{1,2})\+?\s*(?:years?|yrs?)\b/i)
  if (!match || match.index === undefined) return { years: null, isHardRequirement: true }
  const years = Number.parseInt(match[1], 10)
  if (Number.isNaN(years)) return { years: null, isHardRequirement: true }

  const after = requirements.slice(
    match.index + match[0].length,
    match.index + match[0].length + SOFT_QUALIFIER_WINDOW_CHARS,
  )
  const isHardRequirement = !SOFT_QUALIFIER_PATTERN.test(after)
  return { years, isHardRequirement }
}

function guessDegreeRequirement(requirements: string | null): 'none' | 'preferred' | 'required' {
  if (!requirements) return 'none'
  const lower = requirements.toLowerCase()
  if (/bachelor'?s?\s+degree\s+required|must\s+have\s+a\s+degree/.test(lower)) return 'required'
  if (/bachelor'?s?\s+degree\s+preferred|degree\s+(?:is\s+)?a\s+plus/.test(lower)) return 'preferred'
  return 'none'
}

function extractSkillTokens(requirements: string | null): string[] {
  if (!requirements) return []
  const KNOWN_SKILLS = [
    'javascript', 'typescript', 'python', 'java', 'go', 'golang', 'ruby', 'php', 'c++', 'c#',
    'react', 'vue', 'angular', 'node.js', 'node', 'next.js', 'django', 'flask', 'rails',
    'postgresql', 'mysql', 'mongodb', 'redis', 'graphql', 'rest', 'aws', 'gcp', 'azure',
    'docker', 'kubernetes', 'sql', 'llm', 'openai', 'anthropic', 'machine learning',
  ]
  const lower = requirements.toLowerCase()
  return KNOWN_SKILLS.filter((skill) => lower.includes(skill))
}

export async function runIngestPipeline(): Promise<IngestRunStats> {
  const supabase = createServiceClient()
  const stats: IngestRunStats = {
    sourced: 0, deduped: 0, scored: 0, autoQueued: 0, queuedIfCapacity: 0, reviewLowPriority: 0, rejected: 0, errors: [],
  }

  const { data: runRow, error: runError } = await supabase
    .from('job_search_runs')
    .insert({ run_type: 'source', status: 'running', run_trigger_source: 'cron' })
    .select('id')
    .single()
  if (runError || !runRow) {
    // job_search_runs_one_running_per_type_idx (partial unique index on
    // run_type where status = 'running') rejects this insert when a
    // sourcing run is already in flight — treat that as an expected,
    // graceful no-op (overlapping cron trigger / manual re-trigger) rather
    // than an error, so it doesn't fire redundant external API calls
    // against Greenhouse/Lever or spam job_search_events with a failure.
    if (runError?.code === POSTGRES_UNIQUE_VIOLATION) {
      return { ...stats, skippedAlreadyRunning: true }
    }
    throw new Error(`Could not start job-search run: ${runError?.message}`)
  }
  const runId = runRow.id as string

  try {
    const profile = await getActiveProfile()
    const founderYearsExperience = profile ? deriveYearsExperience(profile) : null
    const founderSkills = profile?.skills ?? []
    const targetTitles = profile?.targetTitles ?? []
    const founderHasDegree = profile ? deriveHasDegree(profile) : false

    const { data: sources, error: sourcesError } = await supabase
      .from('job_search_sources')
      .select('source_key, adapter_type, config')
      .eq('enabled', true)
    if (sourcesError) throw new Error(sourcesError.message)

    const allPostings: RawJobPosting[] = []
    for (const source of sources ?? []) {
      const adapter = getSourceAdapter(source.source_key)
      if (!adapter) continue
      try {
        const { postings, errors } = await adapter.fetchCandidates((source.config as Record<string, unknown>) ?? {})
        allPostings.push(...postings)
        // Per-board/site failures inside a source (e.g. one bad Greenhouse
        // board token among several configured) previously vanished
        // silently — Promise.allSettled inside the adapter absorbed them
        // so this outer try/catch never saw them. Surface them here so a
        // dead/misconfigured source doesn't fail 100% silently forever.
        stats.errors.push(...errors)
      } catch (err) {
        stats.errors.push(`${source.source_key}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    stats.sourced = allPostings.length

    const byCanonicalKey = new Map<string, { posting: RawJobPosting; sources: { sourceKey: string; sourceUrl: string; discoveredAt: string }[] }>()
    const nowISO = new Date().toISOString()
    for (const posting of allPostings) {
      const key = computeCanonicalKey(posting)
      const existing = byCanonicalKey.get(key)
      if (existing) {
        existing.sources.push({ sourceKey: posting.sourceKey, sourceUrl: posting.sourceUrl, discoveredAt: nowISO })
      } else {
        byCanonicalKey.set(key, { posting, sources: [{ sourceKey: posting.sourceKey, sourceUrl: posting.sourceUrl, discoveredAt: nowISO }] })
      }
    }
    stats.deduped = byCanonicalKey.size

    for (const [canonicalKey, { posting, sources: discoveredVia }] of byCanonicalKey) {
      const requirements = posting.requirements ?? null
      const fullText = `${posting.description ?? ''}\n${requirements ?? ''}`
      const signals = detectWorkAuthSignals(fullText)
      const { years: minYears, isHardRequirement: yearsIsHardRequirement } = parseYearsRequired(requirements)
      const degreeReq = guessDegreeRequirement(requirements)
      const candidateSkills = extractSkillTokens(requirements)

      const result = scoreCandidate({
        title: posting.title,
        targetTitles,
        candidateSkills,
        founderSkills,
        requiresDegree: degreeReq,
        founderHasDegree,
        minYearsExperienceRequired: minYears,
        experienceRequirementIsHard: yearsIsHardRequirement,
        founderYearsExperience,
        location: posting.location ?? null,
        remoteType: posting.remoteType ?? 'unknown',
        founderOpenToRelocation: Boolean(profile?.locationPreferences?.open_to_relocation),
        founderOpenToRemoteOnly: Boolean(profile?.locationPreferences?.open_to_remote_only),
        salaryMin: posting.salary?.min ?? null,
        founderMinAcceptableSalary: null,
        postedAt: posting.postedAt ?? null,
        discoveredAt: nowISO,
        extraScreenerQuestionCount: 0,
        signals,
        verifiedSponsorshipOverride: false,
      })

      const status =
        result.bucket === 'auto_queue' || result.bucket === 'queue_if_capacity'
          ? 'QUEUED'
          : result.bucket === 'review_low_priority'
            ? 'HUMAN_REVIEW'
            : 'REJECTED'

      const { data: upserted, error: upsertError } = await supabase
        .from('job_search_candidates')
        .upsert(
          {
            canonical_key: canonicalKey,
            company: posting.company,
            title: posting.title,
            requisition_id: posting.requisitionId ?? null,
            location: posting.location ?? null,
            remote_type: posting.remoteType ?? 'unknown',
            employment_type: posting.employmentType ?? null,
            salary: posting.salary ?? null,
            description: posting.description ?? null,
            requirements: posting.requirements ?? null,
            posted_at: posting.postedAt ?? null,
            source_url: posting.sourceUrl,
            apply_url: posting.applyUrl,
            discovered_via: discoveredVia,
            work_auth_signals: signals,
            citizenship_required: signals.citizenshipRequired,
            clearance_required: signals.clearanceRequired,
            opt_excluded: signals.optExcluded,
            min_years_experience_required: minYears,
            skills: candidateSkills,
            fit_score: result.score,
            score_explanation: result.breakdown,
            hard_block_reason: result.gate.outcome === 'blocked' ? result.gate.reason : null,
            rejection_reasons: result.rejectionReasons,
            status,
            updated_at: nowISO,
          },
          { onConflict: 'canonical_key' },
        )
        .select('id')
        .single()

      if (upsertError || !upserted) {
        stats.errors.push(`upsert ${canonicalKey}: ${upsertError?.message}`)
        continue
      }

      stats.scored += 1
      if (result.bucket === 'auto_queue') stats.autoQueued += 1
      else if (result.bucket === 'queue_if_capacity') stats.queuedIfCapacity += 1
      else if (result.bucket === 'review_low_priority') stats.reviewLowPriority += 1
      else stats.rejected += 1

      await logJobSearchEvent({
        eventType: status === 'REJECTED' ? 'candidate_rejected' : status === 'HUMAN_REVIEW' ? 'candidate_needs_human' : 'candidate_scored',
        entityType: 'candidate',
        entityId: upserted.id,
        payload: { score: result.score, bucket: result.bucket, gate: result.gate },
      })
    }

    await supabase
      .from('job_search_runs')
      .update({ status: 'completed', completed_at: new Date().toISOString(), stats })
      .eq('id', runId)

    await logJobSearchEvent({ eventType: 'run_completed', entityType: 'run', entityId: runId, payload: stats })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await supabase.from('job_search_runs').update({ status: 'failed', completed_at: new Date().toISOString(), error: message, stats }).eq('id', runId)
    await logJobSearchEvent({ eventType: 'run_failed', entityType: 'run', entityId: runId, payload: { error: message } })
    throw err
  }

  return stats
}

function deriveYearsExperience(profile: { experience: unknown[] }): number | null {
  if (!Array.isArray(profile.experience) || profile.experience.length === 0) return null
  // Placeholder-shaped profile data has no computable dates yet; a real
  // profile's experience entries (start_date/end_date) would be summed
  // here once populated. Returns null (unknown) rather than guessing.
  return null
}

function deriveHasDegree(profile: { education: unknown[] }): boolean {
  return Array.isArray(profile.education) && profile.education.length > 0
}
