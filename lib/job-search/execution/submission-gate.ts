/**
 * THE SUBMISSION AUTHORITY BOUNDARY.
 *
 * Everything upstream of this file prepares an application. Everything
 * downstream of it can contact a real employer. This module is the single
 * place that decides whether that transition is allowed, and it is written on
 * the assumption that every input it was handed earlier is now stale.
 *
 * Preflight already checked most of this. That is not a reason to skip it
 * here, it is the reason to repeat it: between preflight and the click there
 * is a claim round-trip, a network field-discovery call, several database
 * reads, a browser launch, a page navigation, and a form fill. That window is
 * seconds to tens of seconds wide. A founder who hits emergency pause inside
 * it expects the pause to win, and an application that stopped qualifying
 * inside it must not be sent.
 *
 * Two entry points, deliberately asymmetric:
 *
 *   - `authorizeSubmission` runs the FULL check and, last of all, takes the
 *     atomic daily reservation. It runs before the browser opens.
 *   - `revalidateSubmissionAuthority` runs the same read-only checks again
 *     with the form filled and the cursor over the button. It takes no
 *     reservation, because one is already held.
 *
 * Both fail closed. Any read error is a refusal, never a pass.
 */
import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { isProhibitedApplyDestination } from '../policy-gate'
import { getJobSearchSettings } from '../settings'
import { getExecutionRolloutSettings } from './rollout'
import { validateDestination } from './ssrf-guard'
import { isAllowedAtsHost } from './allowed-destinations'
import { reserveSubmissionSlot } from './reservation'
import type { ApplicationClaim } from './claim'
import type { ExecutionProvider } from './types'

export type SubmissionAuthorityInput = {
  claim: ApplicationClaim
  provider: ExecutionProvider
  applyUrl: string
  company: string
  resumeArtifactId: string
  resumeVariantId: string
}

export type SubmissionDenial = { ok: false; reason: string; category: string }
export type SubmissionAuthorityResult = { ok: true } | SubmissionDenial

function deny(category: string, reason: string): SubmissionDenial {
  return { ok: false, category, reason }
}

/**
 * Every read-only authority check, in the order that fails cheapest first.
 * Shared verbatim by the pre-browser authorization and the pre-click
 * revalidation so the two can never disagree about what "authorized" means.
 */
export async function checkSubmissionAuthority(input: SubmissionAuthorityInput): Promise<SubmissionAuthorityResult> {
  const supabase = createServiceClient()

  // --- Rollout kill switches -------------------------------------------
  const rollout = await getExecutionRolloutSettings()
  if (rollout.emergencyPaused) return deny('emergency_paused', 'Execution is emergency-paused; no application may be submitted.')
  if (rollout.dryRun) return deny('dry_run_active', 'Dry-run mode is active; a readiness pass may never submit an application.')
  if (!rollout.automationEnabled) return deny('automation_disabled', 'Live application automation is disabled; no real submission is authorized.')

  const settings = await getJobSearchSettings()
  if (settings.paused) return deny('job_search_paused', 'The job-search pipeline is paused.')

  // --- Provider scope ---------------------------------------------------
  if (input.provider !== 'greenhouse') return deny('provider_unsupported', `Provider "${input.provider}" has no audited live-submission path.`)
  if (!rollout.allowlistedProviders.includes(input.provider)) return deny('provider_not_allowlisted', `Provider "${input.provider}" is not in the rollout allowlist.`)

  // --- Destination, revalidated from scratch ----------------------------
  const destination = validateDestination(input.applyUrl)
  if (!destination.allowed) return deny('destination_rejected', `Apply destination failed validation: ${destination.reason}`)
  if (!isAllowedAtsHost('greenhouse', destination.hostname ?? '')) return deny('destination_rejected', 'Apply destination is not an allowlisted Greenhouse host.')
  if (isProhibitedApplyDestination(input.applyUrl)) return deny('prohibited_destination', 'Apply destination is a prohibited platform.')

  if (rollout.allowlistedEmployerDomains.length > 0) {
    const hostname = (destination.hostname ?? '').toLowerCase()
    const allowed = rollout.allowlistedEmployerDomains.some((d) => hostname.endsWith(d.toLowerCase()) || input.company.toLowerCase() === d.toLowerCase())
    if (!allowed) return deny('employer_not_allowlisted', 'An employer allowlist is configured and this employer is not on it.')
  }

  // --- The application row itself, re-read ------------------------------
  const { data: application } = await supabase
    .from('job_search_applications')
    .select('id, status, execution_claim_token, resume_variant_id, candidate_id')
    .eq('id', input.claim.applicationId)
    .maybeSingle()
  if (!application) return deny('application_missing', 'Application row disappeared before submission.')

  // The claim is the right to act. Losing it (reaped as stale, or taken)
  // removes the authority to submit even if everything else still passes.
  if (application.status !== 'APPLYING') return deny('claim_lost', `Application status is ${application.status}, not APPLYING — this worker no longer holds the execution claim.`)
  if (application.execution_claim_token !== input.claim.token) return deny('claim_lost', 'The execution claim is now held by a different attempt.')
  if (application.resume_variant_id !== input.resumeVariantId) return deny('artifact_mismatch', 'The application now points at a different resume variant than this attempt prepared.')

  // --- Candidate still qualified ----------------------------------------
  const { data: candidate } = await supabase
    .from('job_search_candidates')
    .select('id, status, apply_url')
    .eq('id', application.candidate_id)
    .maybeSingle()
  if (!candidate) return deny('candidate_missing', 'Candidate row disappeared before submission.')
  if (candidate.status === 'REJECTED') return deny('candidate_rejected', 'Candidate was rejected after this application was prepared.')
  if (candidate.apply_url !== input.applyUrl) return deny('destination_changed', 'The candidate apply URL changed after this attempt started; refusing to submit to a different destination than was validated.')

  // --- Founder identity -------------------------------------------------
  const { data: profile } = await supabase
    .from('job_search_profiles')
    .select('status, contact_email')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (profile?.status !== 'verified') return deny('profile_unverified', 'Founder profile is not verified.')
  if (!profile.contact_email || profile.contact_email.trim().length === 0) return deny('profile_incomplete', 'Founder profile has no contact email.')

  // --- Resume artifact, bound to THIS application and variant -----------
  const { data: variant } = await supabase.from('job_search_resume_variants').select('id, status').eq('id', input.resumeVariantId).maybeSingle()
  if (variant?.status !== 'verified') return deny('resume_unverified', 'Resume variant is not verified.')

  const { data: artifact } = await supabase
    .from('job_search_generated_artifacts')
    .select('id, content, resume_variant_id, application_id')
    .eq('id', input.resumeArtifactId)
    .maybeSingle()
  if (!artifact) return deny('artifact_missing', 'The resume artifact for this attempt no longer exists.')
  if (artifact.application_id !== input.claim.applicationId) return deny('artifact_mismatch', 'The resume artifact is bound to a different application.')
  if (artifact.resume_variant_id !== input.resumeVariantId) return deny('artifact_mismatch', 'The resume artifact is bound to a different resume variant than this application specifies.')
  if (typeof artifact.content !== 'string' || artifact.content.trim().length === 0) return deny('artifact_empty', 'The resume artifact is empty.')

  // --- No unresolved consequential question -----------------------------
  const { data: unresolved } = await supabase
    .from('job_search_application_answers')
    .select('id')
    .eq('application_id', input.claim.applicationId)
    .eq('answer_source', 'needs_human')
    .is('answer', null)
  if ((unresolved ?? []).length > 0) return deny('unresolved_answers', `${(unresolved ?? []).length} required question(s) remain unresolved; refusing to submit an incomplete application.`)

  // --- Never submit twice ------------------------------------------------
  const { data: priorSubmission } = await supabase
    .from('job_search_execution_attempts')
    .select('id')
    .eq('application_id', input.claim.applicationId)
    .in('outcome', ['submitted', 'submission_uncertain'])
    .limit(1)
  if ((priorSubmission ?? []).length > 0) {
    return deny('already_submitted', 'This application already has a submitted or uncertain attempt on record; it must never be submitted a second time.')
  }

  return { ok: true }
}

/**
 * Full authorization, ending with the atomic daily reservation.
 *
 * The reservation is deliberately LAST: it is the only step with a side
 * effect, so every cheap refusal happens before capacity is consumed. It is
 * also the only step that is safe under concurrency by construction - a
 * database transaction, not a read-then-act count.
 */
export async function authorizeSubmission(input: SubmissionAuthorityInput): Promise<{ ok: true; reservationId: string } | SubmissionDenial> {
  const authority = await checkSubmissionAuthority(input)
  if (!authority.ok) return authority

  const reserved = await reserveSubmissionSlot(input.claim)
  if (!reserved) {
    return deny('daily_cap_reached', 'Daily real-submission capacity is unavailable; no submit action was attempted.')
  }

  const supabase = createServiceClient()
  const { data } = await supabase
    .from('job_search_submission_reservations')
    .select('id')
    .eq('application_id', input.claim.applicationId)
    .maybeSingle()

  return { ok: true, reservationId: (data?.id as string) ?? 'unknown' }
}

/**
 * The final check, run with the browser open and the form filled, in the
 * instant before the click. Read-only: the reservation is already held.
 */
export async function revalidateSubmissionAuthority(input: SubmissionAuthorityInput): Promise<{ ok: true } | { ok: false; reason: string }> {
  const authority = await checkSubmissionAuthority(input)
  if (authority.ok) return { ok: true }
  return { ok: false, reason: `Stopped immediately before the submit click: ${authority.reason}` }
}
