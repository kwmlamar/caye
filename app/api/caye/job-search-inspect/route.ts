import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'
import { getActiveFacts, getActiveProfile } from '@/lib/job-search/profile'
import { greenhouseAtsProvider } from '@/lib/job-search/execution/providers/greenhouse'
import { resolveDiscoveredField, STRUCTURAL_SEMANTIC_KEYS } from '@/lib/job-search/execution/answers'
import type { DiscoveredField, FieldResolution } from '@/lib/job-search/execution/types'

const LIMIT = 10

type ApplicationRow = {
  id: string
  candidate_id: string
  status: string
  candidate: { company: string; title: string; apply_url: string } | null
}

function structuralResolution(field: DiscoveredField, profile: Awaited<ReturnType<typeof getActiveProfile>>, hasResume: boolean, hasCoverLetter: boolean): FieldResolution {
  if (!profile) return { status: 'unresolved', field, reason: 'Founder profile missing.' }
  const first = profile.fullName?.trim().split(/\s+/)[0] ?? ''
  const last = profile.fullName?.trim().split(/\s+/).slice(1).join(' ') ?? ''
  switch (field.semanticKey) {
    case 'first_name': return first ? { status: 'resolved', field, value: first, source: 'application_specific', reusable: false } : { status: 'unresolved', field, reason: 'Founder first name missing.' }
    case 'last_name': return last ? { status: 'resolved', field, value: last, source: 'application_specific', reusable: false } : { status: 'unresolved', field, reason: 'Founder last name missing.' }
    case 'email': return profile.contactEmail ? { status: 'resolved', field, value: profile.contactEmail, source: 'application_specific', reusable: false } : { status: 'unresolved', field, reason: 'Founder contact email missing.' }
    case 'phone': return profile.contactPhone ? { status: 'resolved', field, value: profile.contactPhone, source: 'application_specific', reusable: false } : { status: 'unresolved', field, reason: 'Founder phone number missing.' }
    case 'resume': return hasResume ? { status: 'resolved', field, value: '[verified resume artifact ready]', source: 'application_specific', reusable: false } : { status: 'unresolved', field, reason: 'Resume artifact missing.' }
    case 'cover_letter': return hasCoverLetter ? { status: 'resolved', field, value: '[cover letter artifact ready]', source: 'application_specific', reusable: false } : { status: 'unresolved', field, reason: 'Cover-letter artifact missing.' }
    default: return { status: 'unresolved', field, reason: `Unknown structural field: ${field.label}` }
  }
}

export async function inspectApplicationForHumanAssist(applicationId: string) {
  const supabase = createServiceClient()
  const { data: application, error } = await supabase
    .from('job_search_applications')
    .select('id,candidate_id,status,candidate:job_search_candidates(company,title,apply_url)')
    .eq('id', applicationId)
    .maybeSingle()
  if (error || !application) throw new Error(error?.message ?? 'Application not found')
  const row = application as unknown as ApplicationRow
  if (!row.candidate) throw new Error('Candidate missing for application')

  let host = ''
  try { host = new URL(row.candidate.apply_url).hostname.toLowerCase() } catch { /* handled below */ }
  if (!host.includes('greenhouse')) {
    return {
      applicationId,
      company: row.candidate.company,
      title: row.candidate.title,
      applicationStatus: row.status,
      destination: row.candidate.apply_url,
      outcome: 'unsupported_provider',
      blockers: ['Human-assisted inspection currently supports Greenhouse only.'],
    }
  }

  const discovery = await greenhouseAtsProvider.discoverFields(row.candidate.apply_url)
  if (discovery.outcome !== 'clear') {
    return {
      applicationId,
      company: row.candidate.company,
      title: row.candidate.title,
      applicationStatus: row.status,
      destination: row.candidate.apply_url,
      outcome: discovery.outcome,
      blockers: [discovery.reason],
    }
  }

  const profile = await getActiveProfile()
  if (!profile) throw new Error('Founder profile missing')
  const facts = await getActiveFacts(profile.id)
  const { data: artifacts } = await supabase
    .from('job_search_generated_artifacts')
    .select('artifact_type')
    .eq('application_id', applicationId)
  const artifactTypes = new Set((artifacts ?? []).map((a) => a.artifact_type as string))

  const requiredFields = discovery.fields.filter((field) => field.required)
  const resolutions: FieldResolution[] = requiredFields.map((field) => {
    if (field.semanticKey && (STRUCTURAL_SEMANTIC_KEYS as readonly string[]).includes(field.semanticKey)) {
      return structuralResolution(field, profile, artifactTypes.has('resume'), artifactTypes.has('cover_letter'))
    }
    return resolveDiscoveredField(field, facts)
  })

  for (const resolution of resolutions) {
    if (resolution.status === 'resolved') {
      const { error: answerError } = await supabase.from('job_search_application_answers').upsert({
        application_id: applicationId,
        question: resolution.field.label,
        answer: resolution.value,
        answer_source: resolution.source,
        profile_fact_id: resolution.source === 'profile_fact' ? resolution.profileFactId : null,
      }, { onConflict: 'application_id,question' })
      if (answerError) throw new Error(`Could not persist inspection answer: ${answerError.message}`)
    } else {
      const { error: answerError } = await supabase.from('job_search_application_answers').upsert({
        application_id: applicationId,
        question: resolution.field.label,
        answer: null,
        answer_source: 'needs_human' as const,
        profile_fact_id: null,
      }, { onConflict: 'application_id,question' })
      if (answerError) throw new Error(`Could not persist inspection blocker: ${answerError.message}`)
    }
  }

  const unresolved = resolutions.filter((resolution) => resolution.status === 'unresolved')
  const readyForBrowser = unresolved.length === 0
  const reason = unresolved.length
    ? `Human-assisted form inspection found ${unresolved.length} unresolved required field(s): ${unresolved.map((r) => r.status === 'unresolved' ? r.field.label : '').join('; ')}`
    : 'Human-assisted form inspection complete: every discovered required field is resolved. Application is prepared for the browser readiness executor.'
  await supabase.from('job_search_applications').update({
    status: readyForBrowser ? 'PREPARED' : 'NEEDS_HUMAN',
    needs_human_reason: readyForBrowser ? null : reason,
    updated_at: new Date().toISOString(),
  }).eq('id', applicationId)

  const resolved = resolutions.filter((r): r is Extract<FieldResolution, { status: 'resolved' }> => r.status === 'resolved')
  const unresolvedFields = unresolved
    .map((r) => r.status === 'unresolved' ? ({
      label: r.field.label,
      semanticKey: r.field.semanticKey,
      reason: r.reason,
      options: r.field.allowedOptions?.map((o) => o.label) ?? null,
    }) : null)
    .filter(Boolean)

  return {
    applicationId,
    company: row.candidate.company,
    title: row.candidate.title,
    applicationStatus: readyForBrowser ? 'PREPARED' : 'NEEDS_HUMAN',
    destination: row.candidate.apply_url,
    provider: 'greenhouse',
    outcome: readyForBrowser ? 'ready_for_browser' : 'needs_human',
    discoveredRequiredFields: requiredFields.length,
    finalAnswers: resolved.map((r) => ({
      label: r.field.label,
      semanticKey: r.field.semanticKey,
      value: r.value,
      source: r.source,
    })),
    artifacts: {
      resumeReady: artifactTypes.has('resume'),
      coverLetterReady: artifactTypes.has('cover_letter'),
    },
    unresolved: unresolvedFields,
    reviewOnly: true,
    reviewNote: 'This inspection result is for founder review only. The live executor must independently revalidate the form, answers, artifacts, authority, and destination immediately before any submit click.',
  }
}

export async function runJobSearchInspection(): Promise<Record<string, unknown>> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('job_search_applications')
    .select('id')
    .eq('status', 'NEEDS_HUMAN')
    .order('updated_at', { ascending: false })
    .limit(LIMIT)
  if (error) throw new Error(error.message)
  const results = []
  for (const row of data ?? []) {
    try { results.push(await inspectApplicationForHumanAssist(row.id as string)) }
    catch (err) { results.push({ applicationId: row.id, outcome: 'failed', reason: err instanceof Error ? err.message : String(err) }) }
  }
  return { inspected: results.length, results }
}

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (secret) {
    const auth = request.headers.get('authorization')
    const legacy = request.headers.get('x-cron-secret')
    if (auth !== `Bearer ${secret}` && legacy !== secret) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try { return NextResponse.json({ status: 'completed', stats: await runJobSearchInspection() }) }
  catch (err) { return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 }) }
}
