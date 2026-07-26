import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { sendFreeFormWhatsApp } from './outbound'

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
 */
export async function alertFounderOfDeliveryFailure(args: {
  workspaceId: string
  kind: string
  detail: string | null
  stage: 'dispatch' | 'delivery'
}): Promise<void> {
  try {
    const supabase = createServiceClient()
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

    const { data: customer } = await supabase
      .from('customers')
      .select('business_name')
      .eq('id', args.workspaceId)
      .maybeSingle()
    const business = (customer?.business_name as string | null) ?? args.workspaceId

    const stageLabel = args.stage === 'dispatch' ? 'send failed' : 'delivery failed'
    const bucket = Math.floor(Date.now() / (60 * 60 * 1000))
    const result = await sendFreeFormWhatsApp(
      founderPhone,
      `⚠️ ${business}: ${args.kind} ${stageLabel}${args.detail ? ` — ${args.detail.slice(0, 150)}` : ''}`,
      `wa-fail-alert-${args.workspaceId}-${args.kind}-${bucket}`
    )
    if (result.status === 'failed') {
      console.error('[founder-alert] send failed:', result.error)
    }
  } catch (err) {
    console.error('[founder-alert] alert failed:', err)
  }
}
