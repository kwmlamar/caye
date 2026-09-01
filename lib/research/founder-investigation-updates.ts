import 'server-only'
import { createHash } from 'node:crypto'
import type { createServiceClient } from '@/lib/supabase-server'
import { resolveFounderOperator } from '@/lib/operator-identity'
import { linkMessageToThread, touchThread } from '@/lib/caye-direct-threads'

type SupabaseClient = ReturnType<typeof createServiceClient>

export type FounderInvestigationSynthesis = {
  brief: string
  claims: Array<{ confidence?: number | null }>
  conflictingEvidence?: unknown[]
  materialChanges?: string[]
  implications?: string[]
  recommendations?: string[]
}

type UpdateKind = 'initial_answer' | 'new_evidence' | 'contradiction' | 'belief_revision' | 'urgent_implication'

function normalize(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase()
}

function confidence(synthesis: FounderInvestigationSynthesis): number | null {
  const values = synthesis.claims
    .map((claim) => claim.confidence)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
}

function fingerprint(synthesis: FounderInvestigationSynthesis): string {
  const semantic = JSON.stringify({
    brief: normalize(synthesis.brief),
    conflicts: (synthesis.conflictingEvidence ?? []).map((value) => normalize(JSON.stringify(value))),
    changes: (synthesis.materialChanges ?? []).map(normalize).sort(),
    implications: (synthesis.implications ?? []).map(normalize).sort(),
    recommendations: (synthesis.recommendations ?? []).map(normalize).sort(),
  })
  return createHash('sha256').update(semantic).digest('hex')
}

function classify(synthesis: FounderInvestigationSynthesis, firstSurface: boolean): UpdateKind | null {
  if (firstSurface) return 'initial_answer'
  if ((synthesis.conflictingEvidence ?? []).length > 0) return 'contradiction'
  if ((synthesis.materialChanges ?? []).length > 0) return 'belief_revision'
  if ((synthesis.implications ?? []).some((item) => /\b(urgent|critical|immediate|material risk)\b/i.test(item))) return 'urgent_implication'
  if ((synthesis.implications ?? []).length > 0 || (synthesis.recommendations ?? []).length > 0) return 'new_evidence'
  return null
}

function messageFor(kind: UpdateKind, question: string, synthesis: FounderInvestigationSynthesis): string {
  const label: Record<UpdateKind, string> = {
    initial_answer: 'Research update',
    new_evidence: 'New evidence',
    contradiction: 'Research correction',
    belief_revision: 'I changed my mind',
    urgent_implication: 'Urgent research implication',
  }
  const extra = kind === 'belief_revision' && synthesis.materialChanges?.length
    ? `\n\nWhat changed: ${synthesis.materialChanges.slice(0, 3).join('; ')}`
    : kind === 'contradiction' && synthesis.conflictingEvidence?.length
      ? '\n\nI found evidence that conflicts with the earlier picture.'
      : ''
  return `${label[kind]} on “${question}”:\n\n${synthesis.brief}${extra}`.slice(0, 6000)
}

async function upsertOwnerAttention(
  supabase: SupabaseClient,
  args: { workspaceId: string; questionId: string; summary: string; reason: string; priority: 'normal' | 'high' | 'urgent'; now: string },
): Promise<void> {
  const existing = await supabase
    .from('caye_owner_attention')
    .select('id')
    .eq('workspace_id', args.workspaceId)
    .eq('source_type', 'research_investigation')
    .eq('source_id', args.questionId)
    .in('status', ['active', 'snoozed'])
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (existing.error) throw existing.error

  const payload = {
    summary: args.summary.slice(0, 1000),
    reason: args.reason,
    priority: args.priority,
    status: 'active',
    action_required: false,
    updated_at: args.now,
  }
  if (existing.data?.id) {
    const updated = await supabase.from('caye_owner_attention').update(payload).eq('id', existing.data.id)
    if (updated.error) throw updated.error
    return
  }
  const inserted = await supabase.from('caye_owner_attention').insert({
    workspace_id: args.workspaceId,
    source_type: 'research_investigation',
    source_id: args.questionId,
    created_at: args.now,
    ...payload,
  })
  if (inserted.error) throw inserted.error
}

/**
 * Surface one durable founder-originated research update after synthesis commits.
 * Research state remains canonical; Direct and owner-attention are projections.
 */
export async function surfaceFounderInvestigationUpdate(
  supabase: SupabaseClient,
  args: { questionId: string; synthesis: FounderInvestigationSynthesis; now?: string },
): Promise<{ surfaced: boolean; reason: string }> {
  const now = args.now ?? new Date().toISOString()
  const [questionResult, originResult] = await Promise.all([
    supabase
      .from('research_questions')
      .select('id,question,last_founder_surface_fingerprint,last_founder_surface_confidence')
      .eq('id', args.questionId)
      .maybeSingle(),
    supabase
      .from('research_question_origins')
      .select('source_workspace_id,direct_thread_id')
      .eq('question_id', args.questionId)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle(),
  ])
  if (questionResult.error) throw questionResult.error
  if (originResult.error) throw originResult.error
  if (!questionResult.data || !originResult.data?.direct_thread_id) return { surfaced: false, reason: 'not_founder_originated' }

  const nextFingerprint = fingerprint(args.synthesis)
  const previousFingerprint = questionResult.data.last_founder_surface_fingerprint as string | null
  const nextConfidence = confidence(args.synthesis)
  const previousConfidence = questionResult.data.last_founder_surface_confidence as number | null

  if (previousFingerprint === nextFingerprint) return { surfaced: false, reason: 'same_fingerprint' }

  const kind = classify(args.synthesis, !previousFingerprint)
  const confidenceWiggle = kind === null && nextConfidence !== null && previousConfidence !== null && Math.abs(nextConfidence - previousConfidence) < 0.1
  if (kind === null || confidenceWiggle) return { surfaced: false, reason: confidenceWiggle ? 'confidence_wiggle' : 'no_material_change' }

  const workspaceId = originResult.data.source_workspace_id as string
  const threadId = originResult.data.direct_thread_id as string
  const thread = await supabase
    .from('caye_direct_threads')
    .select('id,workspace_id')
    .eq('id', threadId)
    .eq('scope_kind', 'founder')
    .maybeSingle()
  if (thread.error) throw thread.error
  if (!thread.data || thread.data.workspace_id !== workspaceId) return { surfaced: false, reason: 'thread_scope_mismatch' }

  const body = messageFor(kind, questionResult.data.question as string, args.synthesis)
  const founderOperator = await resolveFounderOperator(supabase, workspaceId)
  const inserted = await supabase.from('caye_operator_messages').insert({
    workspace_id: workspaceId,
    direction: 'outbound',
    wa_message_id: null,
    body,
    intent: 'research_update',
    claude_format: { role: 'assistant', content: body },
    operator_allowlist_id: founderOperator?.id ?? null,
    operator_name: founderOperator?.name ?? null,
    operator_role: founderOperator?.role ?? 'founder',
    origin: 'dashboard',
  }).select('id').single()
  if (inserted.error) throw inserted.error
  await linkMessageToThread(supabase, threadId, inserted.data.id, 'caye')
  await touchThread(supabase, threadId)

  const priority = kind === 'urgent_implication' ? 'urgent' : kind === 'contradiction' || kind === 'belief_revision' ? 'high' : 'normal'
  await upsertOwnerAttention(supabase, {
    workspaceId,
    questionId: args.questionId,
    summary: body,
    reason: `research_${kind}`,
    priority,
    now,
  })

  const persisted = await supabase.from('research_questions').update({
    last_founder_surface_fingerprint: nextFingerprint,
    last_founder_surface_confidence: nextConfidence,
    last_founder_surface_at: now,
  }).eq('id', args.questionId)
  if (persisted.error) throw persisted.error
  return { surfaced: true, reason: kind }
}
