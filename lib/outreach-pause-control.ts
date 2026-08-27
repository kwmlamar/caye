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

/**
 * The same trailing-window rule lib/outreach-kill-switch.ts's
 * shouldTripKillSwitch applies live, replayed after the fact against a
 * sorted bounce timestamp list. Returns the earliest timestamp at which the
 * running trailing-`windowHours` count first reached `threshold`, or null if
 * it never did. O(n^2) on the input length, which is fine — a workspace's
 * bounce log is a few dozen rows, not a stream.
 */
export function findTrailingWindowCrossing(isoTimestamps: string[], threshold: number, windowHours: number): string | null {
  const times = isoTimestamps.map((t) => Date.parse(t)).filter((t) => !Number.isNaN(t)).sort((a, b) => a - b)
  const windowMs = windowHours * 60 * 60 * 1000
  for (let i = 0; i < times.length; i++) {
    const windowStart = times[i] - windowMs
    let count = 0
    for (let j = i; j >= 0 && times[j] > windowStart; j--) count++
    if (count >= threshold) return new Date(times[i]).toISOString()
  }
  return null
}

export interface OutreachPauseReconciliation {
  workspaceId: string
  reconciled: boolean
  state: OutreachPauseState
}

/**
 * One-time deterministic backfill for a pause whose provenance was never
 * recorded because it predates 20260824_outreach_pause_provenance.sql. Does
 * NOT clear the pause or make it owner-resumable — it only establishes
 * whether the workspace's own bounce log shows a real threshold crossing
 * that would have tripped lib/outreach-kill-switch.ts, using the exact same
 * rule that code applies going forward. A crossing found this way is
 * retroactive evidence, not a guess: it reconciles the row to
 * `bounce_safety`, which classifyOutreachPause still routes to
 * `safety_recovery_not_supported` — fully blocked from ordinary resume, same
 * as a live bounce trip. No crossing found -> the row is left untouched;
 * provenance genuinely cannot be established and it must keep failing closed
 * as `unknown_blocked`. Safe to call repeatedly (idempotent): once a row has
 * a non-null source, later calls are a no-op.
 */
export async function reconcileLegacyOutreachPause(workspaceId: string): Promise<OutreachPauseReconciliation> {
  const db = createServiceClient()
  const { data: config, error } = await db.from('workspace_ai_config')
    .select('outreach_autosend_paused,outreach_pause_source,outreach_pause_reason,outreach_paused_at,outreach_bounce_threshold,outreach_bounce_window_hours')
    .eq('workspace_id', workspaceId).maybeSingle()
  if (error) throw new Error(error.message)
  const current = classifyOutreachPause({ paused: config?.outreach_autosend_paused ?? false, source: config?.outreach_pause_source, reason: config?.outreach_pause_reason, pausedAt: config?.outreach_paused_at })
  if (!current.paused || current.source !== 'unknown') return { workspaceId, reconciled: false, state: current }

  const threshold = config?.outreach_bounce_threshold ?? 5
  const windowHours = config?.outreach_bounce_window_hours ?? 24
  const { data: bounces, error: bounceError } = await db.from('caye_outreach_bounces')
    .select('created_at').eq('workspace_id', workspaceId)
  if (bounceError) throw new Error(bounceError.message)
  const crossing = findTrailingWindowCrossing((bounces ?? []).map((b) => b.created_at as string), threshold, windowHours)
  if (!crossing) return { workspaceId, reconciled: false, state: current }

  const reason = `Reconciled from a legacy pause with no recorded provenance: bounce count crossed the safety threshold of ${threshold} within a trailing ${windowHours}h window around ${crossing}. Backfilled retroactively — the original trip predates provenance tracking (20260824_outreach_pause_provenance.sql).`
  const pausedAt = config?.outreach_paused_at ?? crossing
  // Conditional on source still being null: a concurrent reconciliation run
  // or a fresh manual/system pause must win over this backfill, never be
  // overwritten by it.
  const { data: updated, error: updateError } = await db.from('workspace_ai_config')
    .update({ outreach_pause_source: 'bounce_safety', outreach_pause_reason: reason, outreach_paused_at: pausedAt })
    .eq('workspace_id', workspaceId).eq('outreach_autosend_paused', true).is('outreach_pause_source', null)
    .select('workspace_id')
  if (updateError) throw new Error(updateError.message)
  if (!updated?.length) {
    const { data: latest, error: latestError } = await db.from('workspace_ai_config')
      .select('outreach_autosend_paused,outreach_pause_source,outreach_pause_reason,outreach_paused_at')
      .eq('workspace_id', workspaceId).maybeSingle()
    if (latestError) throw new Error(latestError.message)
    return { workspaceId, reconciled: false, state: classifyOutreachPause({ paused: latest?.outreach_autosend_paused ?? true, source: latest?.outreach_pause_source, reason: latest?.outreach_pause_reason, pausedAt: latest?.outreach_paused_at }) }
  }
  await recordPauseEvent({ workspaceId, action: 'paused', source: 'bounce_safety', reason, actorRole: 'system' })
  return { workspaceId, reconciled: true, state: classifyOutreachPause({ paused: true, source: 'bounce_safety', reason, pausedAt }) }
}

/**
 * Founder-only escape hatch for a resolved bounce-safety stop. This remains
 * unreachable from Caye/the agent layer, only applies to an established
 * `bounce_safety` provenance, rechecks the live trailing-window threshold,
 * requires a written justification, and audits the successful override.
 */
export async function founderOverrideResolvedBounceSafetyPause(workspaceId: string, justification: string): Promise<OutreachPauseState> {
  if (!justification?.trim()) throw new Error('A written justification is required to override a bounce-safety stop.')
  const db = createServiceClient()
  const { data: config, error } = await db.from('workspace_ai_config')
    .select('outreach_autosend_paused,outreach_pause_source,outreach_pause_reason,outreach_paused_at,outreach_bounce_threshold,outreach_bounce_window_hours')
    .eq('workspace_id', workspaceId).maybeSingle()
  if (error) throw new Error(error.message)
  const current = classifyOutreachPause({ paused: config?.outreach_autosend_paused ?? false, source: config?.outreach_pause_source, reason: config?.outreach_pause_reason, pausedAt: config?.outreach_paused_at })
  if (!current.paused || current.source !== 'bounce_safety') return current

  const threshold = config?.outreach_bounce_threshold ?? 5
  const windowHours = config?.outreach_bounce_window_hours ?? 24
  const cutoff = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString()
  const { count, error: bounceError } = await db.from('caye_outreach_bounces')
    .select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId).gte('created_at', cutoff)
  if (bounceError) throw new Error(bounceError.message)
  if ((count ?? 0) >= threshold) return { ...current, activeSafetyCondition: 'bounce_threshold', disposition: 'safety_active' }

  const reason = `Founder override of a resolved bounce-safety stop: ${justification.trim()}`
  const { data: updated, error: updateError } = await db.from('workspace_ai_config')
    .update({ outreach_autosend_paused: false, outreach_pause_source: null, outreach_pause_reason: null, outreach_paused_at: null })
    .eq('workspace_id', workspaceId).eq('outreach_autosend_paused', true).eq('outreach_pause_source', 'bounce_safety')
    .select('workspace_id')
  if (updateError) throw new Error(updateError.message)
  if (!updated?.length) {
    const { data: latest, error: latestError } = await db.from('workspace_ai_config')
      .select('outreach_autosend_paused,outreach_pause_source,outreach_pause_reason,outreach_paused_at')
      .eq('workspace_id', workspaceId).maybeSingle()
    if (latestError) throw new Error(latestError.message)
    return classifyOutreachPause({ paused: latest?.outreach_autosend_paused ?? true, source: latest?.outreach_pause_source, reason: latest?.outreach_pause_reason, pausedAt: latest?.outreach_paused_at })
  }
  await recordPauseEvent({ workspaceId, action: 'resumed', source: 'bounce_safety', reason, actorRole: 'founder' })
  return { paused: false, source: 'bounce_safety', reason: null, pausedAt: null, activeSafetyCondition: null, disposition: 'running' }
}
