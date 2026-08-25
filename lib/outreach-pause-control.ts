import 'server-only'
import { createServiceClient } from './supabase-server'

export type OutreachPauseSource =
  | 'owner_manual'
  | 'bounce_safety'
  | 'provider_safety'
  | 'compliance'
  | 'system_recoverable'
  | 'unknown'
export type OutreachSafetyCondition = 'bounce_threshold' | 'provider_unhealthy' | 'compliance_hold' | null
export type OutreachPauseDisposition =
  | 'running'
  | 'owner_resumable'
  | 'safety_active'
  | 'safety_recovery_not_supported'
  | 'system_resumable'
  | 'unknown_blocked'

export interface OutreachPauseState {
  paused: boolean
  source: OutreachPauseSource
  reason: string | null
  pausedAt: string | null
  activeSafetyCondition: OutreachSafetyCondition
  disposition: OutreachPauseDisposition
}

/**
 * Provenance answers why the switch was set. `activeSafetyCondition` answers
 * whether a deterministic stop exists now. They intentionally are separate:
 * a past bounce stop whose threshold later falls below the limit is not proof
 * that sending is safe again, so it remains held until a future policy adds a
 * real recovery proof.
 */
export function classifyOutreachPause(input: { paused: boolean; source?: string | null; reason?: string | null; pausedAt?: string | null; activeSafetyCondition?: OutreachSafetyCondition }): OutreachPauseState {
  const source: OutreachPauseSource = ['owner_manual', 'bounce_safety', 'provider_safety', 'compliance', 'system_recoverable'].includes(String(input.source))
    ? input.source as Exclude<OutreachPauseSource, 'unknown'>
    : 'unknown'
  const activeSafetyCondition = input.activeSafetyCondition ?? null
  const base = { source, reason: input.reason ?? null, pausedAt: input.pausedAt ?? null, activeSafetyCondition }
  if (!input.paused) return { paused: false, ...base, disposition: 'running' }
  if (source === 'owner_manual') return { paused: true, ...base, disposition: 'owner_resumable' }
  if (source === 'system_recoverable' && !activeSafetyCondition) return { paused: true, ...base, disposition: 'system_resumable' }
  if (source === 'unknown') return { paused: true, ...base, disposition: 'unknown_blocked' }
  if (activeSafetyCondition) return { paused: true, ...base, disposition: 'safety_active' }
  return { paused: true, ...base, disposition: 'safety_recovery_not_supported' }
}

async function recordPauseEvent(input: { workspaceId: string; action: 'paused' | 'resumed'; source: Exclude<OutreachPauseSource, 'unknown'>; reason: string | null; actorRole: 'owner' | 'founder' | 'system' }): Promise<void> {
  const { error } = await createServiceClient().from('caye_outreach_pause_events').insert({
    workspace_id: input.workspaceId, action: input.action, source: input.source, reason: input.reason, actor_role: input.actorRole,
  })
  if (error) throw new Error(error.message)
}

export async function pauseOutreachForOwner(workspaceId: string, reason = 'Paused by owner', actorRole: 'owner' | 'founder' = 'owner'): Promise<void> {
  const db = createServiceClient()
  const { data: existing, error: readError } = await db.from('workspace_ai_config')
    .select('outreach_autosend_paused,outreach_pause_source,outreach_pause_reason,outreach_paused_at')
    .eq('workspace_id', workspaceId).maybeSingle()
  if (readError) throw new Error(readError.message)
  const current = classifyOutreachPause({ paused: existing?.outreach_autosend_paused ?? false, source: existing?.outreach_pause_source, reason: existing?.outreach_pause_reason, pausedAt: existing?.outreach_paused_at })
  // A second "pause" command must never relabel a safety/legacy stop as an
  // owner pause, which would accidentally make it resumable later.
  if (current.paused) return
  const { data: updated, error } = await db.from('workspace_ai_config').update({
    outreach_autosend_paused: true, outreach_pause_source: 'owner_manual', outreach_pause_reason: reason, outreach_paused_at: new Date().toISOString(),
  }).eq('workspace_id', workspaceId).eq('outreach_autosend_paused', false).select('workspace_id')
  if (error) throw new Error(error.message)
  // Existing outreach workspaces always have config. More importantly, a
  // zero-row conditional update means a concurrent safety pause won; never
  // overwrite it with a lower-priority manual provenance label.
  if (!updated?.length) return
  await recordPauseEvent({ workspaceId, action: 'paused', source: 'owner_manual', reason, actorRole })
}

export async function resumeOwnerPausedOutreach(workspaceId: string, actorRole: 'owner' | 'founder'): Promise<OutreachPauseState> {
  const db = createServiceClient()
  const { data, error } = await db.from('workspace_ai_config').select('outreach_autosend_paused,outreach_pause_source,outreach_pause_reason,outreach_paused_at').eq('workspace_id', workspaceId).maybeSingle()
  if (error) throw new Error(error.message)
  const current = classifyOutreachPause({ paused: data?.outreach_autosend_paused ?? true, source: data?.outreach_pause_source, reason: data?.outreach_pause_reason, pausedAt: data?.outreach_paused_at })
  if (current.disposition !== 'owner_resumable') return current
  const { data: updated, error: updateError } = await db.from('workspace_ai_config')
    .update({ outreach_autosend_paused: false, outreach_pause_source: null, outreach_pause_reason: null, outreach_paused_at: null })
    .eq('workspace_id', workspaceId).eq('outreach_autosend_paused', true).eq('outreach_pause_source', 'owner_manual')
    .select('workspace_id')
  if (updateError) throw new Error(updateError.message)
  if (!updated?.length) {
    const { data: latest, error: latestError } = await db.from('workspace_ai_config')
      .select('outreach_autosend_paused,outreach_pause_source,outreach_pause_reason,outreach_paused_at')
      .eq('workspace_id', workspaceId).maybeSingle()
    if (latestError) throw new Error(latestError.message)
    return classifyOutreachPause({ paused: latest?.outreach_autosend_paused ?? true, source: latest?.outreach_pause_source, reason: latest?.outreach_pause_reason, pausedAt: latest?.outreach_paused_at })
  }
  await recordPauseEvent({ workspaceId, action: 'resumed', source: 'owner_manual', reason: 'Owner-authorized recovery', actorRole })
  return { paused: false, source: 'owner_manual', reason: null, pausedAt: null, activeSafetyCondition: null, disposition: 'running' }
}

export async function recordBounceKillSwitchPause(workspaceId: string, reason: string): Promise<void> {
  const db = createServiceClient()
  const { error } = await db.from('workspace_ai_config').update({
    outreach_autosend_paused: true, outreach_pause_source: 'bounce_safety', outreach_pause_reason: reason, outreach_paused_at: new Date().toISOString(),
  }).eq('workspace_id', workspaceId)
  if (error) throw new Error(error.message)
  await recordPauseEvent({ workspaceId, action: 'paused', source: 'bounce_safety', reason, actorRole: 'system' })
}
