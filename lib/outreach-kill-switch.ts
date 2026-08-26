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
 * Bounce recording itself lives in lib/outreach-bounce-evidence.ts, where a
 * claimed DSN receives attribution and a durable receipt before this safety
 * notification can be sent.
 */

/**
 * Pure threshold check, extracted so it's unit-testable without a Supabase
 * double — same pattern as lib/nudge-eligibility.ts's decideOutreachLeadAction.
 */
export function shouldTripKillSwitch(bounceCountInWindow: number, threshold: number): boolean {
  return bounceCountInWindow >= threshold
}

/**
 * Direct-send page to the founder, bypassing the outbound queue and the
 * morning digest — same pattern as lib/cron-run-log.ts's
 * alertFounderOfStaleCrons. A kill-switch trip is exactly the "worth
 * breaking cadence for" case the daily-digest reporting design (decisions-
 * log 2026-08-12) called out as the one exception to "everything else is a
 * daily rollup."
 */
export async function pageFounderOutreachPaused(bounceCount: number, windowHours: number): Promise<void> {
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
