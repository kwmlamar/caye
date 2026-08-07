import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { sendFreeFormWhatsApp } from './outbound'
import { sendFounderAlertEmail } from '@/lib/email/founder-mailer'
import { classifyDeliveryError, extractErrorCode } from './delivery-errors'

/**
 * Alert the founder (platform-wide phone, lib/cron-run-log.ts's
 * platform_settings.founder_phone — not a per-workspace operator_allowlist
 * lookup) when an operator-bound WhatsApp send permanently fails, either at
 * dispatch time (Meta rejected the send outright — blocked, template
 * mismatch, etc.) or after Meta accepted it but later reported delivery
 * failure via the status webhook.
 *
 * Without this, a failed row just sits in caye_outbound_queue with nobody
 * told — confirmed live 2026-07-23: a morning_digest template-param
 * mismatch sat as status='failed' for 3 days before anyone noticed, only
 * surfacing when Karenda separately reported missing WhatsApp messages.
 *
 * Bucketed hourly per (workspace, kind) so a burst of failures from the
 * same underlying cause doesn't fire one WhatsApp per row. Never throws —
 * call fire-and-forget from the send/status paths.
 *
 * account_fatal failures (WABA billing/eligibility — every workspace is
 * down, not just this one) get different treatment: dedup is global
 * instead of per-(workspace,kind), because one outage should be one alert,
 * not one per workspace that happens to send during it. And the primary
 * channel is email, not WhatsApp — alerting over the exact channel that's
 * broken is how 93 failed operator pings over 14 days produced 4 alert log
 * rows. WhatsApp is still attempted best-effort alongside email (cheap,
 * and works fine for the non-account-fatal classes it usually fires for).
 * See briefs/whatsapp-delivery-reliability.md.
 *
 * Only ever fires for a send that was actually ATTEMPTED and failed. There
 * used to be a third stage, 'skipped', for sends the scan crons declined to
 * make because the operator's 24h window was closed — removed 2026-08-06.
 * A closed window is the resting state for an owner who messages Caye a few
 * times a week, so it fired on nearly every scan and paged the founder 3x/
 * day about a condition with no available action. The scan crons' notify
 * pings still route through the outbound queue, so a genuine failure to
 * reach the operator surfaces here via the dispatch/delivery paths.
 */
export async function alertFounderOfDeliveryFailure(args: {
  workspaceId: string
  kind: string
  detail: string | null
  stage: 'dispatch' | 'delivery'
}): Promise<void> {
  try {
    const supabase = createServiceClient()
    const failureClass = classifyDeliveryError(extractErrorCode(args.detail))
    const isAccountFatal = failureClass === 'account_fatal'

    const { data: customer } = await supabase
      .from('customers')
      .select('business_name')
      .eq('id', args.workspaceId)
      .maybeSingle()
    const business = (customer?.business_name as string | null) ?? args.workspaceId

    const stageLabel = args.stage === 'dispatch' ? 'send failed' : 'delivery failed'
    const bucket = Math.floor(Date.now() / (60 * 60 * 1000))
    // Global key for account_fatal — every workspace hitting the same WABA
    // outage in the same hour collapses to one alert instead of one each.
    const alertKey = isAccountFatal
      ? `wa-fail-alert-account-fatal-${bucket}`
      : `wa-fail-alert-${args.workspaceId}-${args.kind}-${bucket}`

    // The bucket above only matters if something actually checks it — Meta
    // does not dedupe sends on biz_opaque_callback_data, it's just opaque
    // tracking data echoed back in webhooks. Without this insert-or-skip
    // guard, every stale/failed row in the bucket sent its own real
    // WhatsApp (confirmed live 2026-07-26: a burst of Bimini
    // escalation_followup rows produced 8+ near-identical founder alerts).
    const { error: dedupErr } = await supabase
      .from('caye_founder_alert_log')
      .insert({ alert_key: alertKey })
    if (dedupErr) {
      if (dedupErr.code === '23505') return // already alerted this bucket
      console.error('[founder-alert] dedup check failed:', dedupErr)
      return
    }

    const messageBody = isAccountFatal
      ? `⚠️ WhatsApp account-wide failure (${failureClass}) — every workspace is affected. First seen: ${business}, ${args.kind} ${stageLabel}${args.detail ? ` — ${args.detail.slice(0, 300)}` : ''}`
      : `⚠️ ${business}: ${args.kind} ${stageLabel}${args.detail ? ` — ${args.detail.slice(0, 150)}` : ''}`

    if (isAccountFatal) {
      const { data: emailSetting } = await supabase
        .from('platform_settings')
        .select('value')
        .eq('key', 'founder_email')
        .maybeSingle()
      const founderEmail = emailSetting?.value as string | undefined
      if (founderEmail) {
        const emailResult = await sendFounderAlertEmail({
          to: founderEmail,
          subject: `Caye: WhatsApp is down account-wide (${failureClass})`,
          body: messageBody,
        })
        if (!emailResult.ok) {
          console.error('[founder-alert] account-fatal email failed:', emailResult.error)
        }
      } else {
        console.error('[founder-alert] account-fatal failure but no founder_email configured:', args.detail)
      }
    }

    const { data: setting } = await supabase
      .from('platform_settings')
      .select('value')
      .eq('key', 'founder_phone')
      .maybeSingle()
    const founderPhone = setting?.value as string | undefined
    if (!founderPhone) {
      console.error(
        `[founder-alert] ${args.kind} ${args.stage} failure for workspace ${args.workspaceId} but no founder_phone configured:`,
        args.detail
      )
      return
    }

    const result = await sendFreeFormWhatsApp(founderPhone, messageBody, alertKey)
    if (result.status === 'failed') {
      console.error('[founder-alert] whatsapp send failed:', result.error)
    }
  } catch (err) {
    console.error('[founder-alert] alert failed:', err)
  }
}
