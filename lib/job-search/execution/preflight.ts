/**
 * Job-search operator (CAY-194 / #194) — deterministic execution preflight.
 *
 * Every check here runs BEFORE any execution claim is acquired and BEFORE
 * any network call to an ATS. A preflight failure must never transition an
 * application into APPLYING — executor.ts enforces this by only calling
 * claimApplicationForExecution() after runPreflight() returns 'clear'.
 *
 * The provider is derived from the candidate's own apply-URL hostname
 * (never from any caller-supplied or LLM-supplied value) — see
 * derivedProvider below — so a candidate whose data was somehow tampered
 * with to claim "greenhouse" while pointing at an unrelated host can never
 * reach the Greenhouse executor.
 */
import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { isProhibitedApplyDestination } from '../policy-gate'
import { getJobSearchSettings } from '../settings'
import { getExecutionRolloutSettings, getRemainingDailySubmissionCapacity } from './rollout'
import { validateDestination } from './ssrf-guard'
import { isAllowedAtsHost } from './allowed-destinations'
import type { ExecutionProvider } from './types'

export type PreflightCheck = { key: string; passed: boolean; detail: string }

export type PreflightContext = {
  applicationId: string
  candidateId: string
  applyUrl: string
  company: string
  provider: ExecutionProvider
  resumeArtifactId: string
  resumeVariantId: string
  dryRun: boolean
}

export type PreflightResult =
  | { outcome: 'clear'; checks: PreflightCheck[]; context: PreflightContext }
  | { outcome: 'blocked'; checks: PreflightCheck[]; reason: string }

/** Derives the provider from the apply URL's own hostname — never from caller/LLM input, never from a stored "provider" label that could drift from the real destination. */
function deriveProvider(applyUrl: string): ExecutionProvider {
  let hostname: string
  try {
    hostname = new URL(applyUrl).hostname.toLowerCase()
  } catch {
    return 'generic'
  }
  if (isAllowedAtsHost('greenhouse', hostname)) return 'greenhouse'
  return 'generic'
}

function check(key: string, passed: boolean, detail: string): PreflightCheck {
  return { key, passed, detail }
}

export async function runPreflight(applicationId: string): Promise<PreflightResult> {
  const supabase = createServiceClient()
  const checks: PreflightCheck[] = []

  const { data: application } = await supabase
    .from('job_search_applications')
    .select('id, status, candidate_id, resume_variant_id')
    .eq('id', applicationId)
    .maybeSingle()

  if (!application) {
    return { outcome: 'blocked', checks: [check('application_exists', false, 'Application not found.')], reason: 'Application not found.' }
  }
  checks.push(check('application_exists', true, 'Application row found.'))

  // 2 & 11 — not already submitted / no existing active claim. PREPARED is
  // the only status eligible for a fresh execution attempt. This also
  // covers SUBMISSION_UNCERTAIN and APPLYING — neither is ever silently
  // re-attempted from here.
  const notAlreadyHandled = application.status === 'PREPARED'
  checks.push(
    check(
      'application_not_already_handled',
      notAlreadyHandled,
      notAlreadyHandled
        ? 'Application is PREPARED and eligible for a fresh attempt.'
        : `Application status is ${application.status} — only PREPARED applications may start a new execution attempt. ${application.status === 'SUBMISSION_UNCERTAIN' ? 'A previous attempt left this in an uncertain state; it requires human resolution, never an automatic retry.' : ''}`,
    ),
  )
  if (!notAlreadyHandled) {
    return { outcome: 'blocked', checks, reason: checks[checks.length - 1].detail }
  }

  const { data: candidate } = await supabase
    .from('job_search_candidates')
    .select('id, apply_url, company, status')
    .eq('id', application.candidate_id)
    .maybeSingle()
  if (!candidate) {
    checks.push(check('candidate_exists', false, 'Candidate row not found.'))
    return { outcome: 'blocked', checks, reason: 'Candidate not found.' }
  }
  checks.push(check('candidate_exists', true, 'Candidate row found.'))

  // 1 — job still valid enough to attempt. No live "still open" signal
  // exists in this schema (see PR description); the closest deterministic
  // proxy available is that nothing downstream already rejected it.
  const stillViable = candidate.status !== 'REJECTED'
  checks.push(check('candidate_still_viable', stillViable, stillViable ? 'Candidate has not been rejected since preparation.' : 'Candidate was rejected after this application was prepared.'))
  if (!stillViable) return { outcome: 'blocked', checks, reason: checks[checks.length - 1].detail }

  // 4 & 5 — policy gate + prohibited destination, re-checked at execution
  // time (not just at prepare time) in case anything changed.
  const prohibited = isProhibitedApplyDestination(candidate.apply_url)
  checks.push(check('destination_not_prohibited_platform', !prohibited, prohibited ? 'Apply destination is LinkedIn/Indeed — never automated.' : 'Apply destination is not a prohibited platform.'))
  if (prohibited) return { outcome: 'blocked', checks, reason: checks[checks.length - 1].detail }

  const destinationCheck = validateDestination(candidate.apply_url)
  checks.push(check('destination_network_safe', destinationCheck.allowed, destinationCheck.allowed ? 'Apply URL resolves to a safe network destination.' : destinationCheck.reason))
  if (!destinationCheck.allowed) return { outcome: 'blocked', checks, reason: destinationCheck.reason }

  const provider = deriveProvider(candidate.apply_url)
  const providerSupported = provider === 'greenhouse'
  checks.push(check('provider_supported', providerSupported, providerSupported ? 'Provider (Greenhouse) has an automated executor.' : `Provider derived from apply URL ("${provider}") has no automated executor yet — human review required.`))
  if (!providerSupported) return { outcome: 'blocked', checks, reason: checks[checks.length - 1].detail }

  // 3 — job-search not paused (PREPARE-phase pause) + execution rollout
  // controls (independent gate).
  const settings = await getJobSearchSettings()
  checks.push(check('job_search_not_paused', !settings.paused, settings.paused ? 'Job-search pipeline is paused.' : 'Job-search pipeline is not paused.'))
  if (settings.paused) return { outcome: 'blocked', checks, reason: checks[checks.length - 1].detail }

  const rollout = await getExecutionRolloutSettings()
  checks.push(check('execution_not_emergency_paused', !rollout.emergencyPaused, rollout.emergencyPaused ? 'Execution is emergency-paused.' : 'Execution is not emergency-paused.'))
  if (rollout.emergencyPaused) return { outcome: 'blocked', checks, reason: checks[checks.length - 1].detail }

  // Readiness dry-run and live submission are SEPARATE authorities, and this
  // check reports which one (if either) is open.
  //
  // `automation_enabled` governs the consequential act of submitting a real
  // application. It is not a master switch for this module: a dry-run is
  // structurally non-submitting (executor.ts returns before provider.submit(),
  // and the browser readiness module has no submit selector), so gating it on
  // the live-action switch forced a founder to arm real submission just to
  // test the safe path. Dry-run therefore stands on its own authority here.
  //
  // What this does NOT do is let a dry-run inherit submission permission: the
  // reverse implication (automation_enabled ⇒ may submit) is unchanged, and
  // is enforced separately in executor.ts, which only reaches the live branch
  // when dry-run is off at BOTH preflight and post-claim revalidation.
  const executionModeAllowed = rollout.dryRun || rollout.automationEnabled
  checks.push(
    check(
      'execution_mode_allowed',
      executionModeAllowed,
      rollout.dryRun
        ? 'Readiness dry-run is permitted. Live submission automation is not required for, and is not granted by, this mode.'
        : rollout.automationEnabled
          ? 'Live submission automation is enabled.'
          : 'Readiness dry-run and live submission automation are both disabled — no execution mode is open.',
    ),
  )
  if (!executionModeAllowed) return { outcome: 'blocked', checks, reason: checks[checks.length - 1].detail }

  const providerAllowlisted = rollout.allowlistedProviders.includes(provider)
  checks.push(check('provider_allowlisted', providerAllowlisted, providerAllowlisted ? `Provider "${provider}" is allowlisted for rollout.` : `Provider "${provider}" is not in the rollout allowlist.`))
  if (!providerAllowlisted) return { outcome: 'blocked', checks, reason: checks[checks.length - 1].detail }

  if (rollout.allowlistedEmployerDomains.length > 0) {
    let hostname = ''
    try {
      hostname = new URL(candidate.apply_url).hostname.toLowerCase()
    } catch {
      /* already validated above; unreachable in practice */
    }
    const domainAllowed = rollout.allowlistedEmployerDomains.some((d) => hostname.endsWith(d.toLowerCase()) || candidate.company.toLowerCase() === d.toLowerCase())
    checks.push(check('employer_domain_allowlisted', domainAllowed, domainAllowed ? 'Employer is within the configured allowlist.' : 'Employer allowlist is configured and this employer is not on it.'))
    if (!domainAllowed) return { outcome: 'blocked', checks, reason: checks[checks.length - 1].detail }
  }

  // 10 — daily cap remains. The cap bounds REAL submissions, so a dry-run
  // neither requires nor consumes capacity: a readiness pass sends nothing to
  // an employer, and blocking it at cap=0 would make the safe path
  // untestable exactly when the founder most wants to check it. The live
  // path's own atomic reservation in executor.ts is unchanged and remains the
  // authoritative enforcement point; this read stays a fail-fast courtesy.
  if (rollout.dryRun) {
    checks.push(check('daily_cap_remaining', true, 'Readiness dry-run neither requires nor consumes daily submission capacity.'))
  } else {
    const remaining = await getRemainingDailySubmissionCapacity()
    checks.push(check('daily_cap_remaining', remaining > 0, remaining > 0 ? `${remaining} submission(s) remain under today's cap.` : 'Daily submission cap already reached.'))
    if (remaining <= 0) return { outcome: 'blocked', checks, reason: checks[checks.length - 1].detail }
  }

  // 6 & 7 — founder profile and resume variant verified.
  const { data: profile } = await supabase.from('job_search_profiles').select('status, contact_email').order('created_at', { ascending: true }).limit(1).maybeSingle()
  const profileVerified = profile?.status === 'verified'
  checks.push(check('founder_profile_verified', profileVerified, profileVerified ? 'Founder profile is verified.' : 'Founder profile is not verified.'))
  if (!profileVerified) return { outcome: 'blocked', checks, reason: checks[checks.length - 1].detail }

  const hasContactEmail = typeof profile?.contact_email === 'string' && profile.contact_email.trim().length > 0
  checks.push(check('founder_contact_info_present', hasContactEmail, hasContactEmail ? 'Founder contact email is present.' : 'Founder profile is verified but has no contact_email — required by every real ATS submission form.'))
  if (!hasContactEmail) return { outcome: 'blocked', checks, reason: checks[checks.length - 1].detail }

  const { data: resumeVariant } = await supabase
    .from('job_search_resume_variants')
    .select('id, status')
    .eq('id', application.resume_variant_id)
    .maybeSingle()
  const variantVerified = resumeVariant?.status === 'verified'
  checks.push(check('resume_variant_verified', variantVerified, variantVerified ? 'Resume variant is verified.' : 'Resume variant is not verified.'))
  if (!variantVerified) return { outcome: 'blocked', checks, reason: checks[checks.length - 1].detail }

  // 8 — generated artifact exists, has content, and is tied to THIS
  // application's exact resume_variant_id (provenance-safe: it was only
  // ever generated in application-executor.ts's prepare step from
  // already-verified source material, and must match the variant the
  // application record itself points at — not merely any resume artifact
  // that happens to reference this application_id).
  const { data: artifact } = await supabase
    .from('job_search_generated_artifacts')
    .select('id, content, resume_variant_id')
    .eq('application_id', applicationId)
    .eq('artifact_type', 'resume')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  const artifactContentValid = !!artifact && typeof artifact.content === 'string' && artifact.content.trim().length > 0
  const artifactVariantMatches = !!artifact && artifact.resume_variant_id === application.resume_variant_id
  const artifactValid = artifactContentValid && artifactVariantMatches
  checks.push(
    check(
      'resume_artifact_present',
      artifactValid,
      artifactValid
        ? 'A non-empty resume artifact exists for this application, tied to the correct resume variant.'
        : !artifactContentValid
          ? 'No usable resume artifact exists for this application.'
          : 'The resume artifact found is tied to a different resume_variant_id than this application specifies — refusing to use a mismatched artifact.',
    ),
  )
  if (!artifactValid) return { outcome: 'blocked', checks, reason: checks[checks.length - 1].detail }

  // 9 & 12 — no unresolved (needs_human, unanswered) required field left
  // over from preparation.
  const { data: unresolvedAnswers } = await supabase
    .from('job_search_application_answers')
    .select('id, question')
    .eq('application_id', applicationId)
    .eq('answer_source', 'needs_human')
    .is('answer', null)
  const hasUnresolved = (unresolvedAnswers ?? []).length > 0
  checks.push(
    check(
      'no_unresolved_human_review_blocker',
      !hasUnresolved,
      hasUnresolved
        ? `${(unresolvedAnswers ?? []).length} unresolved required field(s) from preparation: ${(unresolvedAnswers ?? []).map((a) => a.question).join('; ')}`
        : 'No unresolved required fields from preparation.',
    ),
  )
  if (hasUnresolved) return { outcome: 'blocked', checks, reason: checks[checks.length - 1].detail }

  return {
    outcome: 'clear',
    checks,
    context: {
      applicationId,
      candidateId: candidate.id,
      applyUrl: candidate.apply_url,
      company: candidate.company,
      provider,
      resumeArtifactId: artifact!.id,
      resumeVariantId: application.resume_variant_id,
      dryRun: rollout.dryRun,
    },
  }
}
