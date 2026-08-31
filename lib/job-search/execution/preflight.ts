/**
 * Job-search operator (CAY-194 / #194) — deterministic execution preflight.
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

  if (!application) return { outcome: 'blocked', checks: [check('application_exists', false, 'Application not found.')], reason: 'Application not found.' }
  checks.push(check('application_exists', true, 'Application row found.'))

  const notAlreadyHandled = application.status === 'PREPARED'
  checks.push(check('application_not_already_handled', notAlreadyHandled, notAlreadyHandled ? 'Application is PREPARED and eligible for a fresh attempt.' : `Application status is ${application.status} — only PREPARED applications may start a new execution attempt. ${application.status === 'SUBMISSION_UNCERTAIN' ? 'A previous attempt left this in an uncertain state; it requires human resolution, never an automatic retry.' : ''}`))
  if (!notAlreadyHandled) return { outcome: 'blocked', checks, reason: checks[checks.length - 1].detail }

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

  const stillViable = candidate.status !== 'REJECTED'
  checks.push(check('candidate_still_viable', stillViable, stillViable ? 'Candidate has not been rejected since preparation.' : 'Candidate was rejected after this application was prepared.'))
  if (!stillViable) return { outcome: 'blocked', checks, reason: checks[checks.length - 1].detail }

  const prohibited = isProhibitedApplyDestination(candidate.apply_url)
  checks.push(check('destination_not_prohibited_platform', !prohibited, prohibited ? 'Apply destination is LinkedIn/Indeed — never automated.' : 'Apply destination is not a prohibited platform.'))
  if (prohibited) return { outcome: 'blocked', checks, reason: checks[checks.length - 1].detail }

  const destinationCheck = validateDestination(candidate.apply_url)
  checks.push(check('destination_network_safe', destinationCheck.allowed, destinationCheck.allowed ? 'Apply URL resolves to a safe network destination.' : destinationCheck.reason))
  if (!destinationCheck.allowed) return { outcome: 'blocked', checks, reason: destinationCheck.reason }

  const provider = deriveProvider(candidate.apply_url)
  const providerSupported = provider === 'greenhouse'
  checks.push(check('provider_supported', providerSupported, providerSupported ? 'Provider (Greenhouse) has a readiness executor.' : `Provider derived from apply URL ("${provider}") has no supported executor yet — human review required.`))
  if (!providerSupported) return { outcome: 'blocked', checks, reason: checks[checks.length - 1].detail }

  const settings = await getJobSearchSettings()
  checks.push(check('job_search_not_paused', !settings.paused, settings.paused ? 'Job-search pipeline is paused.' : 'Job-search pipeline is not paused.'))
  if (settings.paused) return { outcome: 'blocked', checks, reason: checks[checks.length - 1].detail }

  const rollout = await getExecutionRolloutSettings()
  checks.push(check('execution_not_emergency_paused', !rollout.emergencyPaused, rollout.emergencyPaused ? 'Execution is emergency-paused.' : 'Execution is not emergency-paused.'))
  if (rollout.emergencyPaused) return { outcome: 'blocked', checks, reason: checks[checks.length - 1].detail }

  // Safe browser readiness and live submission are separate modes. A dry-run
  // is allowed while the live-action automation switch stays off.
  const executionModeAllowed = rollout.dryRun || rollout.automationEnabled
  checks.push(check(
    'execution_mode_allowed',
    executionModeAllowed,
    rollout.dryRun
      ? 'Dry-run readiness mode is enabled; live submission automation may remain disabled.'
      : rollout.automationEnabled
        ? 'Live application automation is enabled.'
        : 'Neither dry-run readiness mode nor live application automation is enabled.',
  ))
  if (!executionModeAllowed) return { outcome: 'blocked', checks, reason: checks[checks.length - 1].detail }

  const providerAllowlisted = rollout.allowlistedProviders.includes(provider)
  checks.push(check('provider_allowlisted', providerAllowlisted, providerAllowlisted ? `Provider "${provider}" is allowlisted for rollout.` : `Provider "${provider}" is not in the rollout allowlist.`))
  if (!providerAllowlisted) return { outcome: 'blocked', checks, reason: checks[checks.length - 1].detail }

  if (rollout.allowlistedEmployerDomains.length > 0) {
    let hostname = ''
    try { hostname = new URL(candidate.apply_url).hostname.toLowerCase() } catch { /* validated above */ }
    const domainAllowed = rollout.allowlistedEmployerDomains.some((d) => hostname.endsWith(d.toLowerCase()) || candidate.company.toLowerCase() === d.toLowerCase())
    checks.push(check('employer_domain_allowlisted', domainAllowed, domainAllowed ? 'Employer is within the configured allowlist.' : 'Employer allowlist is configured and this employer is not on it.'))
    if (!domainAllowed) return { outcome: 'blocked', checks, reason: checks[checks.length - 1].detail }
  }

  // The daily cap constrains real submissions only. A dry-run cannot consume
  // or require a submission slot.
  if (rollout.dryRun) {
    checks.push(check('daily_cap_remaining', true, 'Dry-run readiness does not consume or require submission capacity.'))
  } else {
    const remaining = await getRemainingDailySubmissionCapacity()
    checks.push(check('daily_cap_remaining', remaining > 0, remaining > 0 ? `${remaining} submission(s) remain under today's cap.` : 'Daily submission cap already reached.'))
    if (remaining <= 0) return { outcome: 'blocked', checks, reason: checks[checks.length - 1].detail }
  }

  const { data: profile } = await supabase.from('job_search_profiles').select('status, contact_email').order('created_at', { ascending: true }).limit(1).maybeSingle()
  const profileVerified = profile?.status === 'verified'
  checks.push(check('founder_profile_verified', profileVerified, profileVerified ? 'Founder profile is verified.' : 'Founder profile is not verified.'))
  if (!profileVerified) return { outcome: 'blocked', checks, reason: checks[checks.length - 1].detail }

  const hasContactEmail = typeof profile?.contact_email === 'string' && profile.contact_email.trim().length > 0
  checks.push(check('founder_contact_info_present', hasContactEmail, hasContactEmail ? 'Founder contact email is present.' : 'Founder profile is verified but has no contact_email — required by every real ATS submission form.'))
  if (!hasContactEmail) return { outcome: 'blocked', checks, reason: checks[checks.length - 1].detail }

  const { data: resumeVariant } = await supabase.from('job_search_resume_variants').select('id, status').eq('id', application.resume_variant_id).maybeSingle()
  const variantVerified = resumeVariant?.status === 'verified'
  checks.push(check('resume_variant_verified', variantVerified, variantVerified ? 'Resume variant is verified.' : 'Resume variant is not verified.'))
  if (!variantVerified) return { outcome: 'blocked', checks, reason: checks[checks.length - 1].detail }

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
  checks.push(check('resume_artifact_present', artifactValid, artifactValid ? 'A non-empty resume artifact exists for this application, tied to the correct resume variant.' : !artifactContentValid ? 'No usable resume artifact exists for this application.' : 'The resume artifact found is tied to a different resume_variant_id than this application specifies — refusing to use a mismatched artifact.'))
  if (!artifactValid) return { outcome: 'blocked', checks, reason: checks[checks.length - 1].detail }

  const { data: unresolvedAnswers } = await supabase
    .from('job_search_application_answers')
    .select('id, question')
    .eq('application_id', applicationId)
    .eq('answer_source', 'needs_human')
    .is('answer', null)
  const hasUnresolved = (unresolvedAnswers ?? []).length > 0
  checks.push(check('no_unresolved_human_review_blocker', !hasUnresolved, hasUnresolved ? `${(unresolvedAnswers ?? []).length} unresolved required field(s) from preparation: ${(unresolvedAnswers ?? []).map((a) => a.question).join('; ')}` : 'No unresolved required fields from preparation.'))
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
