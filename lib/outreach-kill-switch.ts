import 'server-only'
import { createServiceClient } from './supabase-server'
import { sendFreeFormWhatsApp } from './whatsapp/outbound'

/**
 * Reactive deliverability protection for autonomous cold outreach
 * (decisions-log 2026-08-12) — catches whatever the preventive layer
 * (lib/outreach-send-limits.ts's daily cap) lets through. Bounce detection
 * is a proxy (lib/sender-classifier.ts's isBounceNotification, subject-
 * pattern matching), not a true bounce API — Zoho Mail doesn't expose one.
 * No complaint-rate signal exists at all; documented as a known gap, not
 * silently promised as covered.
 *
 * Called from app/api/email/poll/route.ts whenever a newly-ingested inbound
 * message to the internal_sales workspace classifies as a bounce.
 */

/**
 * Pure threshold check, extracted so it's unit-testable without a Supabase
 * double — same pattern as lib/nudge-eligibility.ts's decideOutreachLeadAction.
 */
export function shouldTripKillSwitch(bounceCountInWindow: number, threshold: number): boolean {
  return bounceCountInWindow >= threshold
}

/**
 * Logs one bounce and trips outreach_autosend_paused if the trailing-
 * window count crosses the workspace's configured threshold. Safe to call
 * once per actually-new bounce email — each call inserts a row, so callers
 * must not call this more than once for the same message (the poll route
 * only calls it at message-creation time, not on re-reads of an already-
 * ingested message).
 */
export async function recordBounceAndMaybeTrip(workspaceId: string): Promise<void> {
  const supabase = createServiceClient()

  await supabase.from('caye_outreach_bounces').insert({ workspace_id: workspaceId })

  const { data: aiConfig } = await supabase
    .from('workspace_ai_config')
    .select('outreach_autosend_paused, outreach_bounce_threshold, outreach_bounce_window_hours')
    .eq('workspace_id', workspaceId)
    .maybeSingle()

  // No config row yet, or already paused — nothing left to trip.
  if (!aiConfig || aiConfig.outreach_autosend_paused) return

  const threshold = aiConfig.outreach_bounce_threshold ?? 5
  const windowHours = aiConfig.outreach_bounce_window_hours ?? 24
  const cutoff = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString()

  const { count } = await supabase
    .from('caye_outreach_bounces')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
    .gte('created_at', cutoff)

  if (!shouldTripKillSwitch(count ?? 0, threshold)) return

  await supabase
    .from('workspace_ai_config')
    .update({ outreach_autosend_paused: true })
    .eq('workspace_id', workspaceId)

  console.warn(
    `[outreach-kill-switch] tripped for workspace ${workspaceId}: ${count} bounces in the trailing ${windowHours}h (threshold ${threshold})`
  )

  await pageFounderOutreachPaused(count ?? threshold, windowHours)
}

/**
 * Direct-send page to the founder, bypassing the outbound queue and the
 * morning digest — same pattern as lib/cron-run-log.ts's
 * alertFounderOfStaleCrons. A kill-switch trip is exactly the "worth
 * breaking cadence for" case the daily-digest reporting design (decisions-
 * log 2026-08-12) called out as the one exception to "everything else is a
 * daily rollup."
 */
async function pageFounderOutreachPaused(bounceCount: number, windowHours: number): Promise<void> {
  const supabase = createServiceClient()
  const { data: setting } = await supabase
    .from('platform_settings')
    .select('value')
    .eq('key', 'founder_phone')
    .maybeSingle()

  const founderPhone = setting?.value as string | undefined
  if (!founderPhone) {
    console.error('[outreach-kill-switch] tripped but no founder_phone configured to page')
    return
  }

  const result = await sendFreeFormWhatsApp(
    founderPhone,
    `⚠️ Outreach paused: ${bounceCount} bounces in the last ${windowHours}h crossed the threshold. ` +
    `Cold sending stopped automatically — replies to warm leads still work. Check the dashboard when you can.`,
    `outreach-kill-switch-${Math.floor(Date.now() / (60 * 60 * 1000))}`
  )
  if (result.status === 'failed') {
    console.error('[outreach-kill-switch] founder page send failed:', result.error)
  }
}
