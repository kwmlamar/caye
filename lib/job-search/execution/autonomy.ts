/**
 * Autonomous APPLY / SKIP / ESCALATE under founder standing authorization.
 *
 * The distinction this module is built around:
 *
 *   Caye MAY decide whether a job is worth applying to.
 *   Caye MAY NOT decide what is true about the founder.
 *
 * So a consequential action being consequential is NOT a reason to interrupt
 * Lamar — that is what the standing authorization already settled. Caye
 * escalates when INFORMATION or AUTHORITY is missing, and only then. A
 * citizenship question with no verified answer escalates; submitting to a
 * qualified role does not.
 *
 * This is the policy layer. It decides whether an attempt should be made at
 * all. It does not replace execution/preflight.ts or the submission authority
 * boundary in execution/submission-gate.ts — both still run in full on every
 * application, and either can still refuse after this module said APPLY.
 */
import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import {
  getStandingAuthorization,
  standingAuthorizationDenial,
  pauseStandingAuthorization,
  type StandingAuthorization,
} from '../standing-authorization'
import { isProhibitedApplyDestination } from '../policy-gate'
import { logJobSearchEvent } from '../events'
import { getExecutionRolloutSettings, getRemainingDailySubmissionCapacity } from './rollout'
import { getJobSearchSettings } from '../settings'
import { grantBatchAuthorization, runAuthorizedBatch, DEFAULT_BATCH_CONCURRENCY, type BatchOutcome } from './batch'
import type { ExecutionProvider } from './types'

export type AutonomyDecision =
  | { decision: 'APPLY' }
  | { decision: 'SKIP'; category: string; reason: string }
  | { decision: 'ESCALATE'; category: string; reason: string }

export type AutonomyCandidateInput = {
  applicationId: string
  company: string
  title: string
  fitScore: number | null
  provider: ExecutionProvider
  applyUrl: string
  candidateStatus: string
  /** Required questions with no verified founder answer. Never guessed. */
  unresolvedAnswerCount: number
  /** True when a prior attempt already submitted or may have submitted. */
  alreadySubmitted: boolean
  /** Set when preparation recorded a challenge (CAPTCHA, login wall, identity check). */
  challenge?: string | null
}

const skip = (category: string, reason: string): AutonomyDecision => ({ decision: 'SKIP', category, reason })
const escalate = (category: string, reason: string): AutonomyDecision => ({ decision: 'ESCALATE', category, reason })

/**
 * Decide one application against the standing policy.
 *
 * Ordering is deliberate: things that mean "never apply here" come before
 * things that mean "ask", so a duplicate or a prohibited destination is a
 * quiet SKIP rather than an interruption. Escalations are reserved for genuine
 * missing information.
 */
export function decideApplication(policy: StandingAuthorization, input: AutonomyCandidateInput): AutonomyDecision {
  const authorityDenial = standingAuthorizationDenial(policy)
  if (authorityDenial) return escalate('no_standing_authorization', authorityDenial)

  // --- Never twice, no matter what the policy says ----------------------
  if (input.alreadySubmitted) return skip('already_applied', 'This application was already submitted or may have been submitted.')
  if (input.candidateStatus === 'REJECTED') return skip('candidate_rejected', 'The candidate was rejected and is no longer eligible.')

  // --- Inside the founder's envelope? -----------------------------------
  if (!policy.allowedProviders.includes(input.provider)) {
    return skip('provider_unsupported', `${input.provider} has no audited automated submission path.`)
  }
  if (isProhibitedApplyDestination(input.applyUrl)) {
    return skip('prohibited_destination', 'The apply destination is a platform Caye is prohibited from automating.')
  }

  const employer = input.company.trim().toLowerCase()
  if (policy.excludedEmployers.some((excluded) => employer === excluded.trim().toLowerCase())) {
    return skip('employer_excluded', `${input.company} is on the founder's excluded-employer list.`)
  }

  const fitScore = input.fitScore ?? 0
  if (fitScore < policy.minFitScore) {
    return skip('below_fit_threshold', `Fit score ${input.fitScore ?? 'unknown'} is below the standing threshold of ${policy.minFitScore}.`)
  }

  if (policy.allowedJobFamilies.length > 0) {
    const title = input.title.toLowerCase()
    if (!policy.allowedJobFamilies.some((family) => title.includes(family.toLowerCase()))) {
      return skip('outside_job_family', `"${input.title}" is outside the job families the founder authorized.`)
    }
  }

  // --- Missing information, not missing nerve ---------------------------
  if (input.challenge) {
    return escalate('challenge_encountered', `This application needs a human: ${input.challenge}`)
  }
  if (input.unresolvedAnswerCount > 0) {
    return escalate(
      'unresolved_required_question',
      `${input.unresolvedAnswerCount} required question(s) have no verified founder answer. Answering them would mean inventing facts about the founder.`,
    )
  }

  return { decision: 'APPLY' }
}

/**
 * Everything the decision needs about one PREPARED application, read fresh.
 */
export async function loadAutonomyCandidate(applicationId: string): Promise<AutonomyCandidateInput | null> {
  const supabase = createServiceClient()
  const { data: application } = await supabase
    .from('job_search_applications')
    .select('id, candidate_id, status')
    .eq('id', applicationId)
    .maybeSingle()
  if (!application) return null

  const { data: candidate } = await supabase
    .from('job_search_candidates')
    .select('id, company, title, fit_score, status, apply_url')
    .eq('id', application.candidate_id)
    .maybeSingle()
  if (!candidate) return null

  const { data: unresolved } = await supabase
    .from('job_search_application_answers')
    .select('id')
    .eq('application_id', applicationId)
    .eq('answer_source', 'needs_human')
    .is('answer', null)

  const { data: prior } = await supabase
    .from('job_search_execution_attempts')
    .select('id')
    .eq('application_id', applicationId)
    .in('outcome', ['submitted', 'submission_uncertain'])
    .limit(1)

  const applyUrl = String(candidate.apply_url ?? '')
  let provider: ExecutionProvider = 'generic'
  try {
    if (new URL(applyUrl).hostname.toLowerCase().endsWith('greenhouse.io')) provider = 'greenhouse'
  } catch { /* leave generic; the decision will skip it */ }

  return {
    applicationId,
    company: String(candidate.company ?? ''),
    title: String(candidate.title ?? ''),
    fitScore: (candidate.fit_score as number | null) ?? null,
    provider,
    applyUrl,
    candidateStatus: String(candidate.status ?? ''),
    unresolvedAnswerCount: (unresolved ?? []).length,
    alreadySubmitted: (prior ?? []).length > 0,
  }
}

export type AutonomyCycleResult = {
  status: 'idle' | 'ran'
  reason?: string
  capacity?: number
  batch?: BatchOutcome
  pausedByUncertainty?: boolean
}

/**
 * How many real submissions this cycle may make.
 *
 * The lowest of every independent ceiling. The staged rollout cap is included
 * deliberately: standing authorization says the founder trusts the decision,
 * not that the rollout ladder is finished. "150/day" cannot outrank a rollout
 * cap of 1 that exists because no real submission has been confirmed yet.
 */
export async function computeAutonomousCapacity(policy: StandingAuthorization): Promise<number> {
  const supabase = createServiceClient()
  const todayStart = new Date()
  todayStart.setUTCHours(0, 0, 0, 0)

  const { count, error } = await supabase
    .from('job_search_applications')
    .select('id', { count: 'exact', head: true })
    .in('status', ['SUBMITTED', 'SUBMISSION_UNCERTAIN'])
    .gte('submitted_at', todayStart.toISOString())
  if (error) return 0

  const standingRemaining = Math.max(0, policy.maxApplicationsPerDay - (count ?? 0))
  const rolloutRemaining = await getRemainingDailySubmissionCapacity()
  return Math.min(standingRemaining, rolloutRemaining)
}

/**
 * One autonomous cycle: source nothing, decide, submit what qualifies, stop.
 *
 * Reuses the bounded-batch machinery from #342 underneath rather than adding a
 * second execution path — the difference is only where the authorization comes
 * from. Previously a founder turn minted the envelope; now the standing policy
 * does, server-side, with no message required. The envelope is still atomic,
 * still expiring, still consumed one slot at a time by
 * `consume_job_search_batch_slot`.
 */
export async function runStandingAutonomyCycle(options: { concurrency?: number } = {}): Promise<AutonomyCycleResult> {
  const policy = await getStandingAuthorization()
  const denial = standingAuthorizationDenial(policy)
  if (denial) return { status: 'idle', reason: denial }

  // The kill switches outrank standing authorization, always.
  const [settings, rollout] = await Promise.all([getJobSearchSettings(), getExecutionRolloutSettings()])
  if (rollout.emergencyPaused) return { status: 'idle', reason: 'Execution is emergency-paused.' }
  if (settings.paused) return { status: 'idle', reason: 'The job-search pipeline is paused.' }
  if (!rollout.automationEnabled || rollout.dryRun) {
    return { status: 'idle', reason: 'Live application automation is not enabled.' }
  }

  const capacity = await computeAutonomousCapacity(policy)
  if (capacity <= 0) return { status: 'idle', reason: 'No remaining submission capacity today.', capacity: 0 }

  const provider: ExecutionProvider = 'greenhouse'
  if (!policy.allowedProviders.includes(provider)) {
    return { status: 'idle', reason: `The standing policy does not allow ${provider}.` }
  }

  // The envelope is derived from durable policy, not from a model argument.
  const granted = await grantBatchAuthorization({
    provider,
    maxApplications: capacity,
    minScore: policy.minFitScore,
    allowedJobFamilies: policy.allowedJobFamilies,
    windowMinutes: 60,
    actor: 'standing-authorization',
  })
  if (!granted.ok) return { status: 'idle', reason: granted.error }

  const batch = await runAuthorizedBatch(granted.authorization.id, {
    concurrency: options.concurrency ?? DEFAULT_BATCH_CONCURRENCY,
  })

  // One ambiguous submission stops autonomous submitting until a human has
  // reconciled it. We do not know what happened at an employer, and continuing
  // while that is true turns one uncertain result into several.
  let pausedByUncertainty = false
  if (batch.uncertain > 0 && policy.pauseOnSubmissionUncertain) {
    await pauseStandingAuthorization(
      'A submission came back UNCERTAIN. Autonomous applications are paused until it is reconciled.',
      'standing-authorization',
    )
    pausedByUncertainty = true
  }

  await logJobSearchEvent({
    eventType: 'settings_changed',
    entityType: 'settings',
    payload: {
      standing_autonomy_cycle: true,
      capacity,
      attempted: batch.attempted,
      submitted: batch.submitted,
      uncertain: batch.uncertain,
      paused_by_uncertainty: pausedByUncertainty,
    },
    createdBy: 'standing-authorization',
  })

  return { status: 'ran', capacity, batch, pausedByUncertainty }
}
