/**
 * Job-search operator (CAY-194 / #194) — application execution orchestrator.
 *
 * This is the single entry point for moving an application from PREPARED
 * toward SUBMITTED. It is intentionally the ONLY place that:
 *   - calls runPreflight() and refuses to proceed on anything but 'clear'
 *     (preflight failure must never transition into APPLYING),
 *   - acquires/releases the execution claim,
 *   - decides provider selection (from the URL-derived provider only),
 *   - decides dry-run behavior (providers never see a dry-run flag; if
 *     rollout.dry_run is true, this function stops before ever calling
 *     provider.submit()),
 *   - writes the job_search_execution_attempts audit row.
 *
 * No provider-specific branching exists here beyond selecting which
 * AtsExecutorProvider implementation to call — see providers/types.ts.
 */
import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { getActiveFacts, getActiveProfile } from '../profile'
import { logJobSearchEvent } from '../events'
import { runPreflight, type PreflightContext } from './preflight'
import { claimApplicationForExecution, releaseExecutionClaim, type ApplicationClaim } from './claim'
import { greenhouseAtsProvider } from './providers/greenhouse'
import { unsupportedProvider } from './providers/unsupported'
import type { AtsExecutorProvider } from './providers/types'
import { resolveDiscoveredField, STRUCTURAL_SEMANTIC_KEYS } from './answers'
import { describeBlockerCategory } from './blockers'
import type { DiscoveredField, DomainValidation, ExecutionProvider, FieldResolution, HumanReviewBlocker } from './types'

export type ExecuteApplicationResult =
  | { outcome: 'preflight_blocked'; reason: string }
  | { outcome: 'skipped_concurrent_claim' }
  | { outcome: 'submitted'; confirmationId: string }
  | { outcome: 'submission_uncertain'; reason: string }
  | { outcome: 'needs_human'; reason: string; dryRun?: boolean }
  | { outcome: 'failed'; reason: string; retryable: boolean }

function selectProvider(provider: ExecutionProvider): AtsExecutorProvider {
  if (provider === 'greenhouse') return greenhouseAtsProvider
  return unsupportedProvider(provider)
}

async function recordAttempt(params: {
  applicationId: string
  attemptNumber: number
  provider: ExecutionProvider
  dryRun: boolean
  outcome: 'submitted' | 'needs_human' | 'submission_uncertain' | 'failed' | 'preflight_blocked'
  preflight?: Record<string, unknown>
  domainValidations?: DomainValidation[]
  fieldsDiscoveredCount?: number
  blockers?: HumanReviewBlocker[]
  submissionResponse?: Record<string, unknown>
  confirmationEvidence?: Record<string, unknown>
  resumeArtifactId?: string | null
  failureReason?: string | null
}): Promise<void> {
  const supabase = createServiceClient()
  const { error } = await supabase.from('job_search_execution_attempts').insert({
    application_id: params.applicationId,
    attempt_number: params.attemptNumber,
    provider: params.provider,
    dry_run: params.dryRun,
    outcome: params.outcome,
    preflight: params.preflight ?? {},
    domain_validations: params.domainValidations ?? [],
    fields_discovered_count: params.fieldsDiscoveredCount ?? 0,
    blockers: params.blockers ?? [],
    submission_response: params.submissionResponse ?? null,
    confirmation_evidence: params.confirmationEvidence ?? null,
    resume_artifact_id: params.resumeArtifactId ?? null,
    failure_reason: params.failureReason ?? null,
    completed_at: new Date().toISOString(),
  })
  // A unique(application_id, attempt_number) collision here means another
  // concurrent call already recorded this exact attempt — benign, not a
  // reason to fail the whole execution result.
  if (error && error.code !== '23505') {
    console.error('[job-search] failed to write execution attempt audit row', error.message)
  }
}

async function fetchArtifactContent(applicationId: string, artifactType: 'resume' | 'cover_letter'): Promise<{ id: string; content: string } | null> {
  const supabase = createServiceClient()
  const { data } = await supabase
    .from('job_search_generated_artifacts')
    .select('id, content')
    .eq('application_id', applicationId)
    .eq('artifact_type', artifactType)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return data ? { id: data.id as string, content: data.content as string } : null
}

export async function executeApplication(applicationId: string): Promise<ExecuteApplicationResult> {
  const preflight = await runPreflight(applicationId)

  if (preflight.outcome === 'blocked') {
    const supabase = createServiceClient()
    const { data: app } = await supabase.from('job_search_applications').select('execution_attempt_count').eq('id', applicationId).maybeSingle()
    await recordAttempt({
      applicationId,
      attemptNumber: (app?.execution_attempt_count ?? 0) + 1,
      provider: 'generic',
      dryRun: true,
      outcome: 'preflight_blocked',
      preflight: Object.fromEntries(preflight.checks.map((c) => [c.key, c.passed])),
      failureReason: preflight.reason,
    })
    return { outcome: 'preflight_blocked', reason: preflight.reason }
  }

  const { context } = preflight
  const claim = await claimApplicationForExecution(applicationId)
  if (!claim) return { outcome: 'skipped_concurrent_claim' }

  try {
    return await runClaimedExecution(claim, context.provider, context)
  } catch (err) {
    // Unexpected exception anywhere in the claimed execution: never leave
    // the claim dangling in APPLYING. Route to NEEDS_HUMAN — an unhandled
    // exception during a consequential action is exactly the kind of
    // ambiguity this operator must never silently retry.
    const message = err instanceof Error ? err.message : String(err)
    await releaseExecutionClaim(claim, 'NEEDS_HUMAN', { needs_human_reason: `Unexpected error during execution: ${message}` })
    await recordAttempt({
      applicationId,
      attemptNumber: claim.attemptNumber,
      provider: context.provider,
      dryRun: context.dryRun,
      outcome: 'needs_human',
      failureReason: message,
    })
    await logJobSearchEvent({ eventType: 'application_needs_human', entityType: 'application', entityId: applicationId, payload: { reason: 'unexpected_execution_error' } })
    return { outcome: 'needs_human', reason: message }
  }
}

async function runClaimedExecution(claim: ApplicationClaim, providerKey: ExecutionProvider, context: PreflightContext): Promise<ExecuteApplicationResult> {
  const provider = selectProvider(providerKey)
  const discovery = await provider.discoverFields(context.applyUrl)

  const finishNeedsHuman = async (reason: string, blockers: HumanReviewBlocker[], domainValidations?: DomainValidation[]): Promise<ExecuteApplicationResult> => {
    await releaseExecutionClaim(claim, 'NEEDS_HUMAN', { needs_human_reason: reason })
    await recordAttempt({
      applicationId: claim.applicationId,
      attemptNumber: claim.attemptNumber,
      provider: providerKey,
      dryRun: context.dryRun,
      outcome: 'needs_human',
      domainValidations,
      blockers,
      failureReason: reason,
    })
    await logJobSearchEvent({ eventType: 'application_needs_human', entityType: 'application', entityId: claim.applicationId, payload: { reason } })
    return { outcome: 'needs_human', reason }
  }

  if (discovery.outcome === 'malformed_url') return finishNeedsHuman(discovery.reason, [{ category: 'malformed_url', label: 'Malformed apply URL', reason: discovery.reason }])
  if (discovery.outcome === 'unsupported_provider') return finishNeedsHuman(discovery.reason, [{ category: 'account_required', label: describeBlockerCategory('account_required'), reason: discovery.reason }])
  if (discovery.outcome === 'prohibited_destination') {
    return finishNeedsHuman(discovery.reason, [{ category: 'prohibited_destination', label: describeBlockerCategory('prohibited_destination'), reason: discovery.reason }], discovery.domainValidations)
  }
  if (discovery.outcome === 'captcha_detected') {
    return finishNeedsHuman(discovery.reason, [{ category: 'captcha', label: describeBlockerCategory('captcha'), reason: discovery.reason }], discovery.domainValidations)
  }
  if (discovery.outcome === 'anti_bot_detected') {
    return finishNeedsHuman(discovery.reason, [{ category: 'anti_bot', label: describeBlockerCategory('anti_bot'), reason: discovery.reason }], discovery.domainValidations)
  }
  if (discovery.outcome === 'discovery_failed') {
    if (discovery.retryable) {
      // Never reached the submit step this attempt — safe to hand back to
      // PREPARED so a later run can try again, unlike a stale-claim
      // timeout (claim.ts) where we can't prove that.
      await releaseExecutionClaim(claim, 'PREPARED')
      await recordAttempt({ applicationId: claim.applicationId, attemptNumber: claim.attemptNumber, provider: providerKey, dryRun: context.dryRun, outcome: 'failed', failureReason: discovery.reason })
      return { outcome: 'failed', reason: discovery.reason, retryable: true }
    }
    return finishNeedsHuman(discovery.reason, [{ category: 'discovery_failed', label: 'Field discovery failed', reason: discovery.reason }])
  }

  // discovery.outcome === 'clear'
  const fields: DiscoveredField[] = discovery.fields
  const profile = await getActiveProfile()
  if (!profile) return finishNeedsHuman('No founder profile found.', [{ category: 'profile_missing', label: 'Founder profile missing', reason: 'No founder profile found.' }])
  const facts = await getActiveFacts(profile.id)

  const structuralFields = fields.filter((f) => f.semanticKey && (STRUCTURAL_SEMANTIC_KEYS as readonly string[]).includes(f.semanticKey))
  const answerableFields = fields.filter((f) => !structuralFields.includes(f))

  const resolutions: FieldResolution[] = []
  const blockers: HumanReviewBlocker[] = []
  for (const field of answerableFields) {
    if (!field.required && !field.semanticKey) continue // optional, unclassified — safe to leave blank, not a blocker
    if (!field.required && field.semanticKey) {
      // Optional but semantically high-risk (e.g. voluntary EEOC
      // demographic questions): never auto-fill even if a fact exists —
      // these are self-identification questions, not facts to reuse.
      continue
    }
    const resolution = resolveDiscoveredField(field, facts)
    resolutions.push(resolution)
    if (resolution.status === 'unresolved') {
      blockers.push({ category: field.semanticKey ?? 'unknown_field', label: describeBlockerCategory(field.semanticKey ?? 'unknown_field'), reason: resolution.reason })
    }
  }

  if (blockers.length > 0) {
    const reason = blockers.map((b) => `${b.label}: ${b.reason}`).join('; ')
    return finishNeedsHuman(reason, blockers, discovery.domainValidations)
  }

  const resumeArtifact = await fetchArtifactContent(claim.applicationId, 'resume')
  if (!resumeArtifact) return finishNeedsHuman('No resume artifact found at submission time.', [{ category: 'artifact_missing', label: 'Resume artifact missing', reason: 'No resume artifact found.' }])
  const coverLetterArtifact = await fetchArtifactContent(claim.applicationId, 'cover_letter')

  const structuralAnswers: FieldResolution[] = structuralFields
    .map((field): FieldResolution | null => {
      switch (field.semanticKey) {
        case 'first_name':
          return { status: 'resolved', field, value: profile.fullName?.split(/\s+/)[0] ?? '', source: 'application_specific', reusable: false }
        case 'last_name':
          return { status: 'resolved', field, value: profile.fullName?.split(/\s+/).slice(1).join(' ') ?? '', source: 'application_specific', reusable: false }
        case 'email':
          return profile.contactEmail ? { status: 'resolved', field, value: profile.contactEmail, source: 'application_specific', reusable: false } : { status: 'unresolved', field, reason: 'No contact email on founder profile.' }
        case 'phone':
          return profile.contactPhone ? { status: 'resolved', field, value: profile.contactPhone, source: 'application_specific', reusable: false } : null // optional — omit rather than block
        default:
          return null
      }
    })
    .filter((r): r is FieldResolution => r !== null)

  const missingStructural = structuralAnswers.filter((r) => r.status === 'unresolved')
  if (missingStructural.length > 0) {
    const reason = missingStructural.map((r) => (r.status === 'unresolved' ? r.reason : '')).join('; ')
    return finishNeedsHuman(reason, [{ category: 'profile_incomplete', label: 'Founder profile missing required contact info', reason }], discovery.domainValidations)
  }

  const allAnswers = [...resolutions, ...structuralAnswers]

  if (context.dryRun) {
    await releaseExecutionClaim(claim, 'NEEDS_HUMAN', { needs_human_reason: 'Dry run completed — destination, field discovery, and canonical answers all checked out. Submission was NOT attempted (automation dry_run is enabled). Disable dry run to allow a real submission.' })
    await recordAttempt({
      applicationId: claim.applicationId,
      attemptNumber: claim.attemptNumber,
      provider: providerKey,
      dryRun: true,
      outcome: 'needs_human',
      domainValidations: discovery.domainValidations,
      fieldsDiscoveredCount: fields.length,
      resumeArtifactId: resumeArtifact.id,
    })
    return { outcome: 'needs_human', reason: 'dry_run_ready', dryRun: true }
  }

  if (!profile.contactEmail) return finishNeedsHuman('Founder profile has no contact email.', [{ category: 'profile_incomplete', label: 'Founder profile incomplete', reason: 'No contact email.' }])

  const submission = await provider.submit(
    {
      applicationId: claim.applicationId,
      candidateId: context.candidateId,
      applyUrl: context.applyUrl,
      resume: { id: resumeArtifact.id, applicationId: claim.applicationId, variantId: context.resumeVariantId, content: resumeArtifact.content, artifactType: 'resume' },
      coverLetter: coverLetterArtifact?.content ?? null,
      answers: allAnswers,
      founder: { fullName: profile.fullName ?? '', email: profile.contactEmail, phone: profile.contactPhone },
    },
    fields,
  )

  if (submission.outcome === 'submitted') {
    await releaseExecutionClaim(claim, 'SUBMITTED', { submitted_at: new Date().toISOString(), method: 'automated_ats', dry_run: false })
    await recordAttempt({
      applicationId: claim.applicationId,
      attemptNumber: claim.attemptNumber,
      provider: providerKey,
      dryRun: false,
      outcome: 'submitted',
      domainValidations: discovery.domainValidations,
      fieldsDiscoveredCount: fields.length,
      resumeArtifactId: resumeArtifact.id,
      submissionResponse: submission.response,
      confirmationEvidence: submission.evidence as unknown as Record<string, unknown>,
    })
    await logJobSearchEvent({ eventType: 'application_submitted', entityType: 'application', entityId: claim.applicationId, payload: { confirmationId: submission.evidence.confirmationId } })
    return { outcome: 'submitted', confirmationId: submission.evidence.confirmationId }
  }

  if (submission.outcome === 'submission_uncertain') {
    await releaseExecutionClaim(claim, 'SUBMISSION_UNCERTAIN', { needs_human_reason: submission.reason })
    await recordAttempt({
      applicationId: claim.applicationId,
      attemptNumber: claim.attemptNumber,
      provider: providerKey,
      dryRun: false,
      outcome: 'submission_uncertain',
      resumeArtifactId: resumeArtifact.id,
      submissionResponse: submission.response,
      failureReason: submission.reason,
    })
    await logJobSearchEvent({ eventType: 'application_failed', entityType: 'application', entityId: claim.applicationId, payload: { reason: 'submission_uncertain' } })
    return { outcome: 'submission_uncertain', reason: submission.reason }
  }

  if (submission.outcome === 'captcha_detected' || submission.outcome === 'anti_bot_detected') {
    return finishNeedsHuman(submission.reason, [{ category: submission.outcome === 'captcha_detected' ? 'captcha' : 'anti_bot', label: describeBlockerCategory(submission.outcome === 'captcha_detected' ? 'captcha' : 'anti_bot'), reason: submission.reason }])
  }

  if (submission.outcome === 'prohibited_destination') {
    return finishNeedsHuman(submission.reason, [{ category: 'prohibited_destination', label: describeBlockerCategory('prohibited_destination'), reason: submission.reason }], submission.domainValidations)
  }

  // submission.outcome === 'failed'
  if (submission.retryable) {
    await releaseExecutionClaim(claim, 'PREPARED')
    await recordAttempt({
      applicationId: claim.applicationId,
      attemptNumber: claim.attemptNumber,
      provider: providerKey,
      dryRun: false,
      outcome: 'failed',
      resumeArtifactId: resumeArtifact.id,
      submissionResponse: submission.response,
      failureReason: submission.reason,
    })
    await logJobSearchEvent({ eventType: 'application_failed', entityType: 'application', entityId: claim.applicationId, payload: { reason: submission.reason, retryable: true } })
    return { outcome: 'failed', reason: submission.reason, retryable: true }
  }

  await releaseExecutionClaim(claim, 'NEEDS_HUMAN', { needs_human_reason: submission.reason })
  await recordAttempt({
    applicationId: claim.applicationId,
    attemptNumber: claim.attemptNumber,
    provider: providerKey,
    dryRun: false,
    outcome: 'failed',
    resumeArtifactId: resumeArtifact.id,
    submissionResponse: submission.response,
    failureReason: submission.reason,
  })
  await logJobSearchEvent({ eventType: 'application_failed', entityType: 'application', entityId: claim.applicationId, payload: { reason: submission.reason, retryable: false } })
  return { outcome: 'failed', reason: submission.reason, retryable: false }
}
