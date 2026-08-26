import 'server-only'
import { createServiceClient } from './supabase-server'
import { getOutreachOperationalStatus, type OutreachOperationalStatus } from './outreach-operational-status'

export interface OutreachRecoveryDecision {
  allowed: boolean
  reasons: string[]
  blockers: string[]
  evidence: { pauseGeneration: string | null; triggeringBounceCount: number; handledBounceCount: number; unresolvedBounceIds: string[]; activeSafetyCondition: string | null }
  evaluatedAt: string
}

interface BounceEvidenceRow {
  id: string
  inbound_message_id: string | null
  recipient_email: string | null
  recipient_suppressed_at: string | null
  attribution_status: string
}

/** Pure policy seam. The model may describe this result but cannot override it. */
export function canOutreachRecover(input: { status: OutreachOperationalStatus; bounces: BounceEvidenceRow[]; evaluatedAt: string }): OutreachRecoveryDecision {
  const { status, bounces, evaluatedAt } = input
  const reasons: string[] = []
  const blockers: string[] = []
  const unresolved = bounces.filter((bounce) =>
    !bounce.inbound_message_id || !bounce.recipient_email || !bounce.recipient_suppressed_at ||
    !['outbound_attributed', 'recipient_attributed'].includes(bounce.attribution_status)
  )
  if (!status.enabled) blockers.push('outreach_disabled')
  if (status.pause.source !== 'bounce_safety') blockers.push(`pause_source_${status.pause.source}`)
  if (!status.pause.paused || !status.pause.generation) blockers.push('pause_not_recoverable')
  if (status.pause.activeSafetyCondition) blockers.push(`active_${status.pause.activeSafetyCondition}`)
  if (bounces.length === 0) blockers.push('triggering_bounces_not_recorded')
  if (unresolved.length) blockers.push('unresolved_bounce_evidence')
  if (blockers.length === 0) reasons.push('All triggering bounce recipients are deterministically attributed and suppressed, and no active safety condition remains.')
  return {
    allowed: blockers.length === 0, reasons, blockers,
    evidence: {
      pauseGeneration: status.pause.generation,
      triggeringBounceCount: bounces.length,
      handledBounceCount: bounces.length - unresolved.length,
      unresolvedBounceIds: unresolved.map((bounce) => bounce.id),
      activeSafetyCondition: status.pause.activeSafetyCondition,
    },
    evaluatedAt,
  }
}

export async function evaluateOutreachSafetyRecovery(workspaceId: string, actorRole: 'owner' | 'founder' | 'system' = 'system'): Promise<OutreachRecoveryDecision> {
  const db = createServiceClient()
  const status = await getOutreachOperationalStatus(workspaceId)
  const pausedAt = status.pause.pausedAt ? new Date(status.pause.pausedAt) : null
  const windowHours = await bounceWindowHours(db, workspaceId)
  const start = pausedAt ? new Date(pausedAt.getTime() - windowHours * 60 * 60 * 1000).toISOString() : null
  const { data, error } = start && pausedAt
    ? await db.from('caye_outreach_bounces').select('id,inbound_message_id,recipient_email,recipient_suppressed_at,attribution_status')
      .eq('workspace_id', workspaceId).gte('created_at', start)
    : { data: [] as BounceEvidenceRow[], error: null }
  if (error) throw new Error(error.message)
  const decision = canOutreachRecover({ status, bounces: (data ?? []) as BounceEvidenceRow[], evaluatedAt: new Date().toISOString() })
  const { error: auditError } = await db.from('caye_outreach_safety_recovery_evidence').insert({
    workspace_id: workspaceId, pause_generation: decision.evidence.pauseGeneration,
    allowed: decision.allowed, blockers: decision.blockers, evidence: decision.evidence,
    evaluated_at: decision.evaluatedAt, actor_role: actorRole,
  })
  if (auditError) throw new Error(`could not audit outreach safety recovery decision: ${auditError.message}`)
  return decision
}

/** Revalidates inside the database immediately before releasing the existing pause. */
export async function recoverOutreachSafetyIfAllowed(workspaceId: string, actorRole: 'owner' | 'founder' | 'system' = 'system'): Promise<{ recovered: boolean; decision: OutreachRecoveryDecision }> {
  const decision = await evaluateOutreachSafetyRecovery(workspaceId, actorRole)
  if (!decision.allowed || !decision.evidence.pauseGeneration) return { recovered: false, decision }
  const db = createServiceClient()
  const { data, error } = await db.rpc('recover_outreach_bounce_safety', {
    p_workspace_id: workspaceId, p_expected_generation: decision.evidence.pauseGeneration,
  })
  if (error) throw new Error(`could not recover outreach safety pause: ${error.message}`)
  if (data === true) return { recovered: true, decision }
  // A bounce/provider update may have won the race after the read. Re-read,
  // audit the concrete current blocker, and leave the switch untouched.
  return { recovered: false, decision: await evaluateOutreachSafetyRecovery(workspaceId, actorRole) }
}

async function bounceWindowHours(db: ReturnType<typeof createServiceClient>, workspaceId: string): Promise<number> {
  const { data, error } = await db.from('workspace_ai_config').select('outreach_bounce_window_hours').eq('workspace_id', workspaceId).maybeSingle()
  if (error) throw new Error(error.message)
  return data?.outreach_bounce_window_hours ?? 24
}
