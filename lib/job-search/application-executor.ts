/**
 * Job-search operator (#192) — application preparation + policy-gated
 * "execution" boundary.
 *
 * IMPORTANT SCOPE BOUNDARY (read before touching this file):
 * This repo has NO existing browser/ATS automation infrastructure (no
 * Playwright/Puppeteer, no headless-browser capability — verified by
 * repo-wide search before writing this). Building one now, in this PR,
 * would mean introducing a wholly new execution surface with real
 * anti-bot/CAPTCHA/account-safety implications — exactly the kind of
 * "fundamentally architectural, security-sensitive" work the engineering
 * rules say should be escalated rather than built by default. Per the
 * issue's own instruction ("if reliable automatic submission cannot be
 * safely completed in this PR, ship the strongest coherent prepare/review
 * architecture and explicitly document that boundary rather than faking
 * it"), this module:
 *
 *   - prepares a full application (resume + optional cover note, both
 *     truthful/traceable via resume-tailoring.ts) up to PREPARED,
 *   - resolves every required screener answer it safely can from verified
 *     profile facts,
 *   - evaluates the deterministic policy gate (prohibited platform check +
 *     unresolved/high-risk answers),
 *   - ALWAYS lands at NEEDS_HUMAN rather than SUBMITTED — there is no code
 *     path in this file that sets status to SUBMITTED. A future PR that
 *     adds real, safe, compliant ATS submission automation is a separate,
 *     explicitly-scoped follow-up (see the PR description for the tracking
 *     issue) and should extend prepareApplication's NEEDS_HUMAN branch,
 *     not bypass it.
 *
 * `ExecutionSignal` exists so a future browser-automation layer has a
 * defined interface to report CAPTCHA/anti-bot/identity-verification
 * signals through — evaluateExecutionSignal proves those signals always
 * resolve to NEEDS_HUMAN and never to an attempted bypass, entirely via
 * unit tests, without needing a real browser today.
 */
import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { isProhibitedApplyDestination } from './policy-gate'
import { generateCoverNote, tailorResume, type ResumeVariantSource } from './resume-tailoring'
import { getActiveFacts, getActiveProfile, type JobSearchProfile } from './profile'
import { getJobSearchSettings } from './settings'
import { logJobSearchEvent } from './events'
import { HIGH_RISK_ANSWER_CATEGORIES, type ExecutionSignal, type ProfileFactRow, type RequiredField } from './types'

export type CandidateForApplication = {
  id: string
  company: string
  title: string
  applyUrl: string
  skills: string[]
  requiredFields: RequiredField[]
}

export type ApplicationPrepareResult =
  | { outcome: 'skipped_paused' }
  | { outcome: 'skipped_unverified_source'; applicationId: string; reason: string }
  | { outcome: 'prohibited_platform'; applicationId: string }
  | { outcome: 'needs_human'; applicationId: string; reason: string }

/** Resolves a required field against verified profile facts only. Never guesses. */
function resolveAnswer(field: RequiredField, facts: ProfileFactRow[]): { source: 'profile_fact'; fact: ProfileFactRow } | { source: 'needs_human' } {
  const match = facts.find((f) => f.category === field.category && f.question.toLowerCase() === field.question.toLowerCase())
  if (match) return { source: 'profile_fact', fact: match }
  return { source: 'needs_human' }
}

/** Pure decision function — given a browser-probe signal, what should the executor do? Always NEEDS_HUMAN, never a bypass. Exported for direct unit testing without any DB/network. */
export function evaluateExecutionSignal(signal: ExecutionSignal): { outcome: 'needs_human'; reason: string } | { outcome: 'clear' } {
  switch (signal.kind) {
    case 'captcha_detected':
      return { outcome: 'needs_human', reason: 'CAPTCHA encountered — automation stopped, never attempted a bypass.' }
    case 'anti_bot_detected':
      return { outcome: 'needs_human', reason: 'Anti-bot protection encountered — automation stopped.' }
    case 'identity_verification_required':
      return { outcome: 'needs_human', reason: 'Identity verification required — automation stopped.' }
    case 'unknown_required_field':
      return { outcome: 'needs_human', reason: `Unknown required field "${signal.field}" — no verified answer, automation stopped rather than guessing.` }
    case 'clear':
      return { outcome: 'clear' }
  }
}

export async function prepareApplication(
  candidate: CandidateForApplication,
  resumeVariant: ResumeVariantSource & { id: string },
): Promise<ApplicationPrepareResult> {
  const supabase = createServiceClient()
  const settings = await getJobSearchSettings()
  if (settings.paused) {
    await logJobSearchEvent({ eventType: 'candidate_needs_human', entityType: 'candidate', entityId: candidate.id, payload: { reason: 'paused' } })
    return { outcome: 'skipped_paused' }
  }

  const profile = await getActiveProfile()
  if (!profile) throw new Error('No founder job_search_profiles row found.')
  const facts = await getActiveFacts(profile.id)

  const idempotencyKey = `apply:${candidate.id}`

  // Idempotent upsert: a re-run against the same candidate updates the
  // existing application row (one per candidate, enforced by the
  // migration's unique(candidate_id)) rather than creating a duplicate.
  const { data: application, error: upsertError } = await supabase
    .from('job_search_applications')
    .upsert(
      { candidate_id: candidate.id, resume_variant_id: resumeVariant.id, idempotency_key: idempotencyKey, status: 'PREPARED', prepared_at: new Date().toISOString() },
      { onConflict: 'candidate_id' },
    )
    .select('id')
    .single()

  if (upsertError || !application) throw new Error(`Could not create/update application: ${upsertError?.message}`)
  const applicationId = application.id as string

  await logJobSearchEvent({ eventType: 'application_prepared', entityType: 'application', entityId: applicationId, payload: { candidateId: candidate.id } })

  // Prohibited platform check — never automates submission to LinkedIn or
  // Indeed, regardless of anything else about this candidate.
  if (isProhibitedApplyDestination(candidate.applyUrl)) {
    await markNeedsHuman(applicationId, 'Apply destination is a prohibited automation target (LinkedIn/Indeed). Founder must apply manually if desired.')
    return { outcome: 'prohibited_platform', applicationId }
  }

  // Refuse to generate any application artifact from unverified source
  // material. The seed migration ships job_search_profiles/resume_variants
  // with status='needs_verification' and literal "NEEDS_VERIFICATION —
  // replace with real, truthful ..." placeholder text — without this
  // check, an unpaused pipeline running before the founder populates real
  // facts would happily tailor a resume/cover note out of that placeholder
  // text and persist it as a generated_artifacts row.
  if (profile.status !== 'verified' || resumeVariant.status !== 'verified') {
    const reason =
      profile.status !== 'verified'
        ? 'Founder profile is not yet verified (job_search_profiles.status = needs_verification) — refusing to generate application content from unverified source material.'
        : `Resume variant "${resumeVariant.variantKey}" is not yet verified (status = needs_verification) — refusing to generate application content from unverified source material.`
    await supabase
      .from('job_search_applications')
      .update({ status: 'NEEDS_HUMAN', needs_human_reason: reason, updated_at: new Date().toISOString() })
      .eq('id', applicationId)
    await logJobSearchEvent({ eventType: 'application_needs_human', entityType: 'application', entityId: applicationId, payload: { reason } })
    return { outcome: 'skipped_unverified_source', applicationId, reason }
  }

  const tailored = tailorResume(resumeVariant, profile, candidate.skills)
  const coverNote = generateCoverNote({
    companyName: candidate.company,
    roleTitle: candidate.title,
    emphasizedSkills: tailored.emphasizedSkills,
    summary: profile.summary ?? '',
  })

  await supabase.from('job_search_generated_artifacts').insert([
    { application_id: applicationId, artifact_type: 'resume', resume_variant_id: resumeVariant.id, content: tailored.content, traced_fact_ids: [] },
    { application_id: applicationId, artifact_type: 'cover_letter', resume_variant_id: resumeVariant.id, content: coverNote, traced_fact_ids: [] },
  ])
  await logJobSearchEvent({ eventType: 'application_artifact_generated', entityType: 'application', entityId: applicationId, payload: { artifactTypes: ['resume', 'cover_letter'] } })

  const unresolvedAnswers: RequiredField[] = []
  for (const field of candidate.requiredFields) {
    const resolution = resolveAnswer(field, facts)
    if (resolution.source === 'profile_fact') {
      await supabase.from('job_search_application_answers').insert({
        application_id: applicationId,
        question: field.question,
        answer: resolution.fact.answer,
        answer_source: 'profile_fact',
        profile_fact_id: resolution.fact.id,
      })
      await logJobSearchEvent({ eventType: 'application_answer_resolved', entityType: 'application', entityId: applicationId, payload: { question: field.question } })
    } else {
      unresolvedAnswers.push(field)
      await supabase.from('job_search_application_answers').insert({
        application_id: applicationId,
        question: field.question,
        answer: null,
        answer_source: 'needs_human',
        profile_fact_id: null,
      })
      await logJobSearchEvent({ eventType: 'application_answer_needs_human', entityType: 'application', entityId: applicationId, payload: { question: field.question, category: field.category } })
    }
  }

  const unresolvedHighRisk = unresolvedAnswers.filter((f) => HIGH_RISK_ANSWER_CATEGORIES.includes(f.category))
  if (unresolvedAnswers.length > 0) {
    const reason =
      unresolvedHighRisk.length > 0
        ? `${unresolvedHighRisk.length} high-risk field(s) require a verified answer: ${unresolvedHighRisk.map((f) => f.question).join('; ')}`
        : `${unresolvedAnswers.length} required field(s) have no verified answer: ${unresolvedAnswers.map((f) => f.question).join('; ')}`
    await markNeedsHuman(applicationId, reason)
    return { outcome: 'needs_human', applicationId, reason }
  }

  // No automated ATS submission exists in this PR (see file doc comment) —
  // even a fully-answerable, non-prohibited-platform application always
  // lands here rather than at SUBMITTED.
  const reason = 'Automated submission is not implemented in this build. Founder review required before this application can be submitted (manually, or by a future automation PR once one exists).'
  await markNeedsHuman(applicationId, reason)
  return { outcome: 'needs_human', applicationId, reason }
}

async function markNeedsHuman(applicationId: string, reason: string): Promise<void> {
  const supabase = createServiceClient()
  await supabase.from('job_search_applications').update({ status: 'NEEDS_HUMAN', needs_human_reason: reason, updated_at: new Date().toISOString() }).eq('id', applicationId)
  await logJobSearchEvent({ eventType: 'application_needs_human', entityType: 'application', entityId: applicationId, payload: { reason } })
}
