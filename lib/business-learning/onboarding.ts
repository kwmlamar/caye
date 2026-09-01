import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { processBusinessLearningObservation } from '@/lib/business-learning/pipeline'
import { buildOwnerOnboardingObservation } from '@/lib/business-learning/onboarding-normalization.js'

const ONBOARDING_EVENT_MAP: Record<string, string> = {
  observation_excluded: 'onboarding_learning_skipped',
  extraction_started: 'onboarding_learning_extraction_started',
  extraction_failed: 'onboarding_learning_failed',
  candidate_created: 'onboarding_learning_candidate_created',
  candidate_deduplicated: 'onboarding_learning_deduplicated',
  fact_promoted: 'onboarding_learning_fact_created',
  fact_updated: 'onboarding_learning_fact_created',
  conflict_resolved: 'onboarding_learning_conflict_resolved',
}

type Supabase = ReturnType<typeof createServiceClient>

interface SubmitOwnerOnboardingLearningInput {
  workspaceId: string
  rawAnswers: unknown
  profile?: Record<string, unknown> | null
  eventTime: string
  actorId?: string | null
  actorName?: string | null
  backfill?: boolean
  dryRun?: boolean
}

export interface SubmitOwnerOnboardingLearningResult {
  ok: boolean
  observationId?: string
  deduplicated?: boolean
  dryRun?: boolean
  sourceFingerprint: string
  status?: string
  error?: string
}

export interface OnboardingBackfillResult {
  dryRun: boolean
  scanned: number
  submitted: number
  deduplicated: number
  skipped: number
  failed: number
  results: Array<SubmitOwnerOnboardingLearningResult & { workspaceId: string }>
}

async function writeOnboardingEvent(
  supabase: Supabase,
  args: {
    workspaceId: string
    observationId?: string | null
    eventType: string
    sourceId: string
    candidateId?: string | null
    factId?: string | null
    details?: Record<string, unknown>
  }
): Promise<void> {
  const query = supabase
    .from('business_learning_events')
    .select('id')
    .eq('workspace_id', args.workspaceId)
    .eq('event_type', args.eventType)
    .eq('source_kind', 'owner_onboarding')
    .eq('source_id', args.sourceId)

  if (args.observationId) query.eq('observation_id', args.observationId)
  if (args.candidateId) query.eq('candidate_id', args.candidateId)
  if (args.factId) query.eq('fact_id', args.factId)

  const { data: existing } = await query.limit(1)
  if (existing?.length) return

  const { error } = await supabase.from('business_learning_events').insert({
    workspace_id: args.workspaceId,
    observation_id: args.observationId ?? null,
    candidate_id: args.candidateId ?? null,
    fact_id: args.factId ?? null,
    event_type: args.eventType,
    source_kind: 'owner_onboarding',
    source_id: args.sourceId,
    job_name: 'owner-onboarding-learning',
    capability: 'business_memory_learning',
    details: args.details ?? {},
  })
  // Parallel completion retries can race between the lookup and insert. The
  // migration's partial unique index turns that race into an idempotent no-op.
  if (error && error.code !== '23505') throw new Error(`onboarding learning event write failed: ${error.message}`)
}

async function mirrorCanonicalEvents(
  supabase: Supabase,
  workspaceId: string,
  observationId: string,
  sourceId: string
): Promise<void> {
  const { data, error } = await supabase
    .from('business_learning_events')
    .select('event_type, candidate_id, fact_id, details')
    .eq('workspace_id', workspaceId)
    .eq('observation_id', observationId)
    .neq('source_kind', 'owner_onboarding')
    .order('created_at', { ascending: true })

  if (error) throw new Error(`onboarding learning event read failed: ${error.message}`)

  for (const row of data ?? []) {
    const eventType = ONBOARDING_EVENT_MAP[String(row.event_type)]
    if (!eventType) continue
    await writeOnboardingEvent(supabase, {
      workspaceId,
      observationId,
      sourceId,
      eventType,
      candidateId: row.candidate_id ? String(row.candidate_id) : null,
      factId: row.fact_id ? String(row.fact_id) : null,
      details: { canonical_event_type: row.event_type, ...(row.details ?? {}) },
    })
  }
}

/**
 * Persist one owner-onboarding observation and synchronously run the normal
 * business-learning processor so newly learned memory is retrievable before
 * onboarding completion returns.
 */
export async function submitOwnerOnboardingLearning(
  input: SubmitOwnerOnboardingLearningInput
): Promise<SubmitOwnerOnboardingLearningResult> {
  const supabase = createServiceClient()
  const observation = buildOwnerOnboardingObservation(input)

  if (!observation.content) {
    return {
      ok: false,
      sourceFingerprint: observation.source_fingerprint,
      error: 'onboarding contained no owner answers to learn from',
    }
  }

  if (input.dryRun) {
    return {
      ok: true,
      dryRun: true,
      sourceFingerprint: observation.source_fingerprint,
      status: 'would_submit',
    }
  }

  try {
    const { data: existing, error: existingError } = await supabase
      .from('business_learning_observations')
      .select('id, status')
      .eq('workspace_id', input.workspaceId)
      .eq('source_fingerprint', observation.source_fingerprint)
      .maybeSingle()
    if (existingError) throw new Error(`onboarding learning dedupe lookup failed: ${existingError.message}`)

    let observationId: string
    let deduplicated = false
    if (existing) {
      observationId = String(existing.id)
      deduplicated = true
      await writeOnboardingEvent(supabase, {
        workspaceId: input.workspaceId,
        observationId,
        sourceId: observation.source_id,
        eventType: 'onboarding_learning_deduplicated',
        details: { reason: 'deterministic source fingerprint already exists' },
      })
    } else {
      const { data: inserted, error: insertError } = await supabase
        .from('business_learning_observations')
        .insert(observation)
        .select('id')
        .single()

      if (insertError?.code === '23505') {
        const { data: raced, error: racedError } = await supabase
          .from('business_learning_observations')
          .select('id, status')
          .eq('workspace_id', input.workspaceId)
          .eq('source_fingerprint', observation.source_fingerprint)
          .single()
        if (racedError || !raced) throw new Error(`onboarding learning race recovery failed: ${racedError?.message ?? 'missing row'}`)
        observationId = String(raced.id)
        deduplicated = true
        await writeOnboardingEvent(supabase, {
          workspaceId: input.workspaceId,
          observationId,
          sourceId: observation.source_id,
          eventType: 'onboarding_learning_deduplicated',
          details: { reason: 'concurrent deterministic source fingerprint insert' },
        })
      } else {
        if (insertError || !inserted) throw new Error(`onboarding learning observation insert failed: ${insertError?.message ?? 'missing row'}`)
        observationId = String(inserted.id)
        await writeOnboardingEvent(supabase, {
          workspaceId: input.workspaceId,
          observationId,
          sourceId: observation.source_id,
          eventType: 'onboarding_learning_submitted',
          details: {
            semantic_scope: 'customer_business',
            actor_type: 'owner',
            actor_id: input.actorId ?? input.workspaceId,
            event_time: input.eventTime,
            backfill: Boolean(input.backfill),
            source_fingerprint: observation.source_fingerprint,
          },
        })
      }
    }

    // A previously failed observation is deliberately retried. Processed or
    // excluded rows are no-ops inside the canonical processor.
    await processBusinessLearningObservation(observationId)
    await mirrorCanonicalEvents(supabase, input.workspaceId, observationId, observation.source_id)

    const { data: finalRow, error: finalError } = await supabase
      .from('business_learning_observations')
      .select('status, processing_error')
      .eq('id', observationId)
      .single()
    if (finalError) throw new Error(`onboarding learning final-state read failed: ${finalError.message}`)

    if (finalRow.status === 'failed') {
      await writeOnboardingEvent(supabase, {
        workspaceId: input.workspaceId,
        observationId,
        sourceId: observation.source_id,
        eventType: 'onboarding_learning_failed',
        details: { error: finalRow.processing_error ?? 'canonical learning failed' },
      })
      return {
        ok: false,
        observationId,
        deduplicated,
        sourceFingerprint: observation.source_fingerprint,
        status: String(finalRow.status),
        error: String(finalRow.processing_error ?? 'canonical learning failed'),
      }
    }

    return {
      ok: true,
      observationId,
      deduplicated,
      sourceFingerprint: observation.source_fingerprint,
      status: String(finalRow.status),
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    try {
      await writeOnboardingEvent(supabase, {
        workspaceId: input.workspaceId,
        sourceId: observation.source_id,
        eventType: 'onboarding_learning_failed',
        details: { error, phase: 'submission_or_processing' },
      })
    } catch (eventErr) {
      console.error('[onboarding-learning] failed to record failure event:', eventErr)
    }
    return { ok: false, sourceFingerprint: observation.source_fingerprint, error }
  }
}

/**
 * Generic historical replay for completed onboarding. It deliberately uses the
 * exact live submission helper, so there is one observation shape, one source
 * identity algorithm, one authority model, and one fact-resolution path.
 */
export async function backfillOwnerOnboardingLearning(options: {
  workspaceId?: string
  dryRun?: boolean
  limit?: number
} = {}): Promise<OnboardingBackfillResult> {
  const supabase = createServiceClient()
  let query = supabase
    .from('workspace_ai_config')
    .select('workspace_id, raw_onboarding_answers, onboarding_answers, onboarding_completed_at, updated_at, created_at')
    .eq('onboarding_complete', true)
    .order('onboarding_completed_at', { ascending: true, nullsFirst: true })
    .limit(Math.max(1, Math.min(options.limit ?? 500, 5000)))

  if (options.workspaceId) query = query.eq('workspace_id', options.workspaceId)

  const { data: rows, error } = await query
  if (error) throw new Error(`onboarding learning backfill read failed: ${error.message}`)

  const result: OnboardingBackfillResult = {
    dryRun: Boolean(options.dryRun),
    scanned: 0,
    submitted: 0,
    deduplicated: 0,
    skipped: 0,
    failed: 0,
    results: [],
  }

  for (const row of rows ?? []) {
    result.scanned += 1
    const workspaceId = String(row.workspace_id)
    const eventTime = String(row.onboarding_completed_at ?? row.updated_at ?? row.created_at ?? new Date(0).toISOString())

    const { data: owner } = await supabase
      .from('customers')
      .select('id, full_name')
      .eq('id', workspaceId)
      .maybeSingle()

    const submitted = await submitOwnerOnboardingLearning({
      workspaceId,
      rawAnswers: row.raw_onboarding_answers,
      profile: row.onboarding_answers && typeof row.onboarding_answers === 'object'
        ? row.onboarding_answers as Record<string, unknown>
        : null,
      eventTime,
      actorId: owner?.id ? String(owner.id) : workspaceId,
      actorName: owner?.full_name ? String(owner.full_name) : null,
      backfill: true,
      dryRun: options.dryRun,
    })
    result.results.push({ workspaceId, ...submitted })

    if (!submitted.ok) result.failed += 1
    else if (submitted.dryRun) result.skipped += 1
    else if (submitted.deduplicated) result.deduplicated += 1
    else result.submitted += 1
  }

  return result
}
