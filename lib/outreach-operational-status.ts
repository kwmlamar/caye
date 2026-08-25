import 'server-only'
import { createServiceClient } from './supabase-server'
import { OUTREACH_DAILY_FIRST_TOUCH_CAP } from './outreach-send-limits'
import { isValidOutreachEmail } from './outreach-email'
import { hasSalesCapability } from './sales/capability'
import { classifyOutreachPause, type OutreachPauseState } from './outreach-pause-control'

export interface OutreachOperationalStatus {
  workspaceId: string
  timezone: string
  enabled: boolean
  paused: boolean
  pause: OutreachPauseState
  schedule: { sourcing: string; autosend: string; nextRunAt: string | null }
  lastScan: { ranAt: string | null; succeeded: boolean | null; summary: Record<string, unknown> | null; error: string | null }
  lastSourcing: { ranAt: string | null; succeeded: boolean | null; summary: Record<string, unknown> | null; error: string | null }
  sendsToday: { sent: number; dailyLimit: number; remaining: number; firstTouch: number; followups: number; firstTouchTarget: number; firstTouchRemaining: number }
  sendsThisMonth: { firstTouch: number; followups: number; total: number }
  queue: { pendingDrafts: number; stalled: number; sourcingJobs: number }
  sourcing: { availableCandidates: number; cooldownCandidates: number; lastFound: number | null; lastQualified: number | null; lastRejected: number | null; lastDuplicates: number | null }
  provider: { connected: boolean; healthy: boolean; kind: string | null; lastError: string | null }
  blockers: string[]
  reasonNoOutreach: string | null
  telemetryComplete: boolean
}

export function explainNoOutreach(s: Omit<OutreachOperationalStatus, 'reasonNoOutreach'>): string | null {
  if (s.sendsToday.sent > 0) return null
  if (s.paused) {
    if (s.pause.activeSafetyCondition) return `Outreach is paused by the active ${s.pause.activeSafetyCondition.replaceAll('_', ' ')} safety stop${s.pause.reason ? `: ${s.pause.reason}` : '.'}`
    if (s.pause.disposition === 'safety_recovery_not_supported') return 'Outreach remains paused after a safety stop because no deterministic recovery proof is supported yet.'
    if (s.pause.disposition === 'unknown_blocked') return 'Outreach is paused and its original reason was not recorded.'
    return 'Outreach is intentionally paused by the owner.'
  }
  if (!s.provider.connected) return 'No active outbound email account is connected.'
  if (!s.provider.healthy) return `The outbound email provider is unhealthy${s.provider.lastError ? `: ${s.provider.lastError}` : '.'}`
  if (s.lastScan.succeeded === false) return `The outreach scan failed${s.lastScan.error ? `: ${s.lastScan.error}` : '.'}`
  if (s.sendsToday.remaining === 0) return 'The workspace daily outreach limit has been reached.'
  if (s.queue.stalled > 0) return `${s.queue.stalled} outreach item(s) are stalled in the queue.`
  const recorded = s.lastScan.summary?.primary_zero_send_reason
  if (typeof recorded === 'string' && recorded !== 'telemetry_incomplete') return `The last scan sent nothing because ${recorded.replaceAll('_', ' ')}.`
  if (s.sourcing.availableCandidates === 0) return 'There are no currently sendable sourced leads.'
  if (!s.telemetryComplete) return 'The available telemetry does not establish a single cause.'
  return `${s.sourcing.availableCandidates} sendable lead(s) exist but the last scan did not process them.`
}

/** One authoritative, workspace-scoped read model for outreach operations. */
export async function getOutreachOperationalStatus(workspaceId: string): Promise<OutreachOperationalStatus> {
  const db = createServiceClient()
  const [customer, config, account, scan, sourcingRun, sourced, cooldown, stalled, sourcingJobs, history] = await Promise.all([
    db.from('customers').select('workspace_kind,autosend_enabled,timezone').eq('id', workspaceId).maybeSingle(),
    db.from('workspace_ai_config').select('outreach_autosend_paused,outreach_pause_source,outreach_pause_reason,outreach_paused_at,outreach_bounce_threshold,outreach_bounce_window_hours').eq('workspace_id', workspaceId).maybeSingle(),
    db.from('connected_accounts').select('id,channel_type,is_active,token_expires_at,refresh_token,updated_at').eq('user_id', workspaceId).eq('channel_type', 'email').eq('is_active', true).maybeSingle(),
    db.from('caye_cron_runs').select('last_started_at,last_status,last_summary,last_error').eq('cron_name', 'outreach-autosend-scan').maybeSingle(),
    db.from('caye_cron_runs').select('last_started_at,last_status,last_summary,last_error').eq('cron_name', 'outreach-sourcing-scan').maybeSingle(),
    db.from('outreach_leads').select('lead_email').eq('workspace_id', workspaceId).eq('stage', 'sourced').is('first_touch_sent_at', null).is('opted_out_at', null),
    db.from('outreach_leads').select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId).not('stage', 'in', '("sourced","won","lost","disqualified")'),
    db.from('outreach_leads').select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId).not('outreach_claim_token', 'is', null),
    db.from('caye_pending_operations').select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId).eq('operation', 'outreach_sourcing').in('status', ['pending', 'processing']),
    db.from('caye_cron_run_history').select('id', { count: 'exact', head: true }).in('cron_name', ['outreach-autosend-scan', 'outreach-sourcing-scan']),
  ])
  const drafts = account.data?.id
    ? await db.from('unified_conversations').select('id,updated_at,metadata').eq('connected_account_id', account.data.id).eq('human_agent_enabled', true)
    : { data: [] as Array<{ id: string; updated_at: string; metadata: unknown }> }
  const timezone = customer.data?.timezone || 'UTC'
  const now = new Date()
  const start = startOfBusinessDay(now, timezone)
  const monthStart = startOfBusinessMonth(now, timezone)
  const [first, follow, monthFirst, monthFollow, bounceCount] = await Promise.all([
    db.from('outreach_leads').select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId).gte('first_touch_sent_at', start),
    db.from('outreach_leads').select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId).gte('last_nudge_at', start),
    db.from('outreach_leads').select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId).gte('first_touch_sent_at', monthStart),
    db.from('outreach_leads').select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId).gte('last_nudge_at', monthStart),
    db.from('caye_outreach_bounces').select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId).gte('created_at',
      new Date(Date.now() - (config.data?.outreach_bounce_window_hours ?? 24) * 60 * 60 * 1000).toISOString()
    ),
  ])
  const sent = (first.count ?? 0) + (follow.count ?? 0)
  const monthFirstTouch = monthFirst.count ?? 0
  const monthFollowups = monthFollow.count ?? 0
  const pending = (drafts.data ?? []).filter((r) => ['outreach_first_touch', 'outreach_followup'].includes(String((r.metadata as Record<string, unknown>)?.hold_kind))).length
  const sourcingSummary = (sourcingRun.data?.last_summary as Record<string, unknown> | null) ?? null
  // Field names match runOutreachSourcingJob's summary (lib/outreach-
  // sourcing-job.ts): totals across every target attempted in the run, not
  // a single target — CAY-98 made one run walk the whole active-target
  // rotation instead of stopping after the first.
  const lastFound = numeric(sourcingSummary?.total_found)
  const lastQualified = numeric(sourcingSummary?.total_with_email)
  const lastInserted = numeric(sourcingSummary?.total_inserted)
  const availableCandidates = (sourced.data ?? []).filter((row) => isValidOutreachEmail(row.lead_email)).length
  const tokenUsable = Boolean(account.data && (account.data.refresh_token || (account.data.token_expires_at && Date.parse(account.data.token_expires_at) > Date.now())))
  const activeSafetyCondition = (bounceCount.count ?? 0) >= (config.data?.outreach_bounce_threshold ?? 5)
    ? 'bounce_threshold'
    : !tokenUsable ? 'provider_unhealthy' : null
  const pause = classifyOutreachPause({
    paused: config.data?.outreach_autosend_paused ?? true,
    source: config.data?.outreach_pause_source,
    reason: config.data?.outreach_pause_reason,
    pausedAt: config.data?.outreach_paused_at,
    activeSafetyCondition,
  })
  const base: Omit<OutreachOperationalStatus, 'reasonNoOutreach'> = {
    workspaceId, timezone,
    enabled: hasSalesCapability(customer.data) && customer.data?.autosend_enabled === true,
    paused: pause.paused,
    pause,
    schedule: { sourcing: 'daily at 09:00 UTC', autosend: 'hourly at :00 UTC', nextRunAt: nextHourlyRun() },
    lastScan: { ranAt: scan.data?.last_started_at ?? null, succeeded: scan.data ? scan.data.last_status === 'ok' : null, summary: (scan.data?.last_summary as Record<string, unknown>) ?? null, error: scan.data?.last_error ?? null },
    lastSourcing: { ranAt: sourcingRun.data?.last_started_at ?? null, succeeded: sourcingRun.data ? sourcingRun.data.last_status === 'ok' : null, summary: sourcingSummary, error: sourcingRun.data?.last_error ?? null },
    sendsToday: {
      sent, dailyLimit: OUTREACH_DAILY_FIRST_TOUCH_CAP, remaining: Math.max(0, OUTREACH_DAILY_FIRST_TOUCH_CAP - (first.count ?? 0)),
      firstTouch: first.count ?? 0, followups: follow.count ?? 0,
      firstTouchTarget: OUTREACH_DAILY_FIRST_TOUCH_CAP,
      firstTouchRemaining: Math.max(0, OUTREACH_DAILY_FIRST_TOUCH_CAP - (first.count ?? 0)),
    },
    sendsThisMonth: { firstTouch: monthFirstTouch, followups: monthFollowups, total: monthFirstTouch + monthFollowups },
    queue: { pendingDrafts: pending, stalled: stalled.count ?? 0, sourcingJobs: sourcingJobs.count ?? 0 },
    sourcing: { availableCandidates, cooldownCandidates: cooldown.count ?? 0, lastFound, lastQualified, lastRejected: numeric(sourcingSummary?.total_rejected_no_email) ?? (lastFound !== null && lastQualified !== null ? lastFound - lastQualified : null), lastDuplicates: numeric(sourcingSummary?.total_duplicates) ?? (lastQualified !== null && lastInserted !== null ? lastQualified - lastInserted : null) },
    provider: { connected: Boolean(account.data), healthy: tokenUsable, kind: account.data?.channel_type ?? null, lastError: account.data && !tokenUsable ? 'No usable access or refresh token' : null },
    blockers: [],
    telemetryComplete: Boolean(scan.data && sourcingRun.data && history.count !== null),
  }
  const reasonNoOutreach = explainNoOutreach(base)
  return { ...base, blockers: reasonNoOutreach ? [reasonNoOutreach] : [], reasonNoOutreach }
}

function numeric(value: unknown): number | null { return typeof value === 'number' ? value : null }

function nextHourlyRun(): string { const d = new Date(); d.setUTCMinutes(0, 0, 0); d.setUTCHours(d.getUTCHours() + 1); return d.toISOString() }

export function startOfBusinessDay(now: Date, timeZone: string): string {
  const parts = businessDateParts(now, timeZone)
  return localDateBoundaryUtc(parts.year, parts.month, parts.day, timeZone).toISOString()
}

export function startOfBusinessMonth(now: Date, timeZone: string): string {
  const parts = businessDateParts(now, timeZone)
  return localDateBoundaryUtc(parts.year, parts.month, 1, timeZone).toISOString()
}

function businessDateParts(now: Date, timeZone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value)
  return { year: get('year'), month: get('month'), day: get('day') }
}

function localDateBoundaryUtc(year: number, month: number, day: number, timeZone: string): Date {
  const noonUtc = new Date(Date.UTC(year, month - 1, day, 12))
  const localHourAtNoon = Number(new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', hour12: false }).format(noonUtc))
  const offsetHours = localHourAtNoon - 12
  return new Date(Date.UTC(year, month - 1, day, -offsetHours))
}
