import 'server-only'
import { createServiceClient } from './supabase-server'

export type OutreachPauseSource = 'owner_manual' | 'bounce_kill_switch' | 'unknown'
export type OutreachPauseDisposition = 'running' | 'owner_resumable' | 'safety_locked' | 'unknown_blocked'

export interface OutreachPauseState {
  paused: boolean
  source: OutreachPauseSource
  reason: string | null
  pausedAt: string | null
  disposition: OutreachPauseDisposition
}

/** A founder may undo a founder-created pause, never a safety or unknown stop. */
export function classifyOutreachPause(input: { paused: boolean; source?: string | null; reason?: string | null; pausedAt?: string | null }): OutreachPauseState {
  const source: OutreachPauseSource = input.source === 'owner_manual' || input.source === 'bounce_kill_switch' ? input.source : 'unknown'
  if (!input.paused) return { paused: false, source, reason: input.reason ?? null, pausedAt: input.pausedAt ?? null, disposition: 'running' }
  if (source === 'owner_manual') return { paused: true, source, reason: input.reason ?? null, pausedAt: input.pausedAt ?? null, disposition: 'owner_resumable' }
  if (source === 'bounce_kill_switch') return { paused: true, source, reason: input.reason ?? null, pausedAt: input.pausedAt ?? null, disposition: 'safety_locked' }
  return { paused: true, source, reason: input.reason ?? null, pausedAt: input.pausedAt ?? null, disposition: 'unknown_blocked' }
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
  const { error } = await db.from('workspace_ai_config').upsert({
    workspace_id: workspaceId, outreach_autosend_paused: true, outreach_pause_source: 'owner_manual', outreach_pause_reason: reason, outreach_paused_at: new Date().toISOString(),
  }, { onConflict: 'workspace_id' })
  if (error) throw new Error(error.message)
  await recordPauseEvent({ workspaceId, action: 'paused', source: 'owner_manual', reason, actorRole })
}

export async function resumeOwnerPausedOutreach(workspaceId: string, actorRole: 'owner' | 'founder'): Promise<OutreachPauseState> {
  const db = createServiceClient()
  const { data, error } = await db.from('workspace_ai_config').select('outreach_autosend_paused,outreach_pause_source,outreach_pause_reason,outreach_paused_at').eq('workspace_id', workspaceId).maybeSingle()
  if (error) throw new Error(error.message)
  const current = classifyOutreachPause({ paused: data?.outreach_autosend_paused ?? true, source: data?.outreach_pause_source, reason: data?.outreach_pause_reason, pausedAt: data?.outreach_paused_at })
  if (current.disposition !== 'owner_resumable') return current
  const { error: updateError } = await db.from('workspace_ai_config').update({ outreach_autosend_paused: false, outreach_pause_source: null, outreach_pause_reason: null, outreach_paused_at: null }).eq('workspace_id', workspaceId)
  if (updateError) throw new Error(updateError.message)
  await recordPauseEvent({ workspaceId, action: 'resumed', source: 'owner_manual', reason: 'Owner-authorized recovery', actorRole })
  return { paused: false, source: 'owner_manual', reason: null, pausedAt: null, disposition: 'running' }
}

export async function recordBounceKillSwitchPause(workspaceId: string, reason: string): Promise<void> {
  const db = createServiceClient()
  const { error } = await db.from('workspace_ai_config').update({
    outreach_autosend_paused: true, outreach_pause_source: 'bounce_kill_switch', outreach_pause_reason: reason, outreach_paused_at: new Date().toISOString(),
  }).eq('workspace_id', workspaceId)
  if (error) throw new Error(error.message)
  await recordPauseEvent({ workspaceId, action: 'paused', source: 'bounce_kill_switch', reason, actorRole: 'system' })
}
