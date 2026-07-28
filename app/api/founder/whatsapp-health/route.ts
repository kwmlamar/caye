/**
 * GET /api/founder/whatsapp-health
 *
 * Cross-workspace WhatsApp operator-ping delivery health, for the founder
 * console's "Caye Command" home. Built after discovering (2026-07-27) that
 * 93 operator pings over 14 days produced zero confirmed deliveries with
 * zero founder alerts — the founder had no way to see channel health
 * except a customer separately reporting missing messages. See
 * briefs/whatsapp-delivery-reliability.md.
 *
 * Reports, per workspace with whatsapp_outbound_enabled=true: current
 * failure streak, unreachable flag, and the most recent confirmed
 * delivered/read timestamp (as opposed to caye_outbound_queue.status,
 * which only means "our API call to Meta succeeded" — see
 * lib/whatsapp/founder-alert.ts for the same distinction).
 *
 * Auth: Bearer JWT, checked against FOUNDER_USER_IDS — same pattern as
 * /api/founder/channels.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient, createServerClient } from '@/lib/supabase-server'
import { isFounderUserId } from '@/lib/founder'
import { OPERATOR_LOGGABLE_KINDS } from '@/app/api/caye/outbound-worker/route'

async function requireFounder(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  const accessToken = authHeader?.replace('Bearer ', '')
  if (!accessToken) return null
  const userClient = createServerClient(accessToken)
  const { data: { user } } = await userClient.auth.getUser()
  if (!user || !isFounderUserId(user.id)) return null
  return user
}

const LOOKBACK_HOURS = 48

export interface WhatsAppHealthRow {
  workspaceId: string
  businessName: string
  failureStreak: number
  unreachable: boolean
  /** Sent operator-loggable pings in the lookback window, regardless of outcome. */
  sentCount: number
  /** Of those, how many Meta confirmed delivered or read. */
  confirmedCount: number
  lastConfirmedAt: string | null
  /** true when sentCount > 0 but confirmedCount === 0 — the exact silent-channel case this exists to catch. */
  noConfirmedDeliveries: boolean
}

export async function GET(req: NextRequest) {
  const user = await requireFounder(req)
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const supabase = createServiceClient()

  const { data: configs, error: configErr } = await supabase
    .from('workspace_ai_config')
    .select('workspace_id, whatsapp_failure_streak, whatsapp_unreachable')
    .eq('whatsapp_outbound_enabled', true)

  if (configErr) {
    return NextResponse.json({ error: configErr.message }, { status: 500 })
  }
  if (!configs?.length) return NextResponse.json({ rows: [] })

  const workspaceIds = configs.map((c) => c.workspace_id as string)

  const { data: customers } = await supabase
    .from('customers')
    .select('id, business_name')
    .in('id', workspaceIds)
  const nameByWorkspace = new Map((customers ?? []).map((c) => [c.id as string, (c.business_name as string | null) ?? c.id as string]))

  const cutoff = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000).toISOString()
  const { data: recentSends } = await supabase
    .from('caye_outbound_queue')
    .select('workspace_id, wa_delivery_status, wa_delivery_status_at, kind')
    .eq('status', 'sent')
    .gte('sent_at', cutoff)
    .in('workspace_id', workspaceIds)
    .in('kind', Array.from(OPERATOR_LOGGABLE_KINDS))

  const rows: WhatsAppHealthRow[] = configs.map((cfg) => {
    const workspaceId = cfg.workspace_id as string
    const sends = (recentSends ?? []).filter((r) => r.workspace_id === workspaceId)
    const confirmed = sends.filter((r) => r.wa_delivery_status === 'delivered' || r.wa_delivery_status === 'read')
    const lastConfirmedAt = confirmed
      .map((r) => r.wa_delivery_status_at as string | null)
      .filter((t): t is string => !!t)
      .sort()
      .at(-1) ?? null

    return {
      workspaceId,
      businessName: nameByWorkspace.get(workspaceId) ?? workspaceId,
      failureStreak: (cfg.whatsapp_failure_streak as number | null) ?? 0,
      unreachable: (cfg.whatsapp_unreachable as boolean | null) ?? false,
      sentCount: sends.length,
      confirmedCount: confirmed.length,
      lastConfirmedAt,
      noConfirmedDeliveries: sends.length > 0 && confirmed.length === 0,
    }
  })

  // Worst first: unconfirmed channels, then by failure streak.
  rows.sort((a, b) => {
    if (a.noConfirmedDeliveries !== b.noConfirmedDeliveries) return a.noConfirmedDeliveries ? -1 : 1
    return b.failureStreak - a.failureStreak
  })

  return NextResponse.json({ rows })
}
