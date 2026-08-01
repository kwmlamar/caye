import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { Tool } from '../../types'

interface ConfigRow {
  workspace_id: string
  opportunity_scan_enabled: boolean
  business_insights_enabled: boolean
  whatsapp_outbound_enabled: boolean | null
  operator_whatsapp_number: string | null
  last_opportunity_scan_at: string | null
  last_business_insights_sent_at: string | null
}

/**
 * Which workspaces have Caye's proactive crons switched on. Companion read
 * for set_workspace_autonomy — both flags default false and nothing else in
 * the product surfaces them, so without this the only way to answer "is the
 * scan actually running for Bimini?" is a manual SQL query.
 *
 * Reports the two delivery preconditions alongside the flags on purpose: a
 * workspace with opportunity_scan_enabled=true but whatsapp_outbound_enabled
 * =false or no operator number is silently skipped by the cron's own query,
 * which reads as "the scan is broken" rather than "it was never eligible."
 */
export const getWorkspaceAutonomy: Tool<Record<string, never>> = {
  name: 'get_workspace_autonomy',
  description:
    "Report which workspaces have Caye's proactive crons enabled — opportunity-scan (she reviews the workspace 3x/day and pings the owner) and business-insights (weekly performance read-out) — plus when each last ran. Also shows whether WhatsApp outbound and an operator number are set, since the crons skip workspaces missing either. Call this before answering any question about whether a scan is on, and before changing a flag with set_workspace_autonomy.",
  risk: 'read',
  roles: ['founder'],
  modes: ['admin-shell'],
  inputSchema: {
    type: 'object',
    properties: {},
  },

  async execute() {
    const supabase = createServiceClient()
    const { data, error } = await supabase
      .from('workspace_ai_config')
      .select(
        'workspace_id, opportunity_scan_enabled, business_insights_enabled, whatsapp_outbound_enabled, operator_whatsapp_number, last_opportunity_scan_at, last_business_insights_sent_at'
      )
    if (error) return { ok: false, error: error.message }

    const rows = (data ?? []) as ConfigRow[]
    if (rows.length === 0) return { ok: true, data: { workspaces: [], count: 0 } }

    const { data: customers } = await supabase
      .from('customers')
      .select('id, business_name')
      .in('id', rows.map((r) => r.workspace_id))
    const nameById = new Map(
      (customers ?? []).map((c: { id: string; business_name: string | null }) => [c.id, c.business_name])
    )

    const workspaces = rows.map((r) => {
      const deliverable = r.whatsapp_outbound_enabled === true && !!r.operator_whatsapp_number
      return {
        workspace_id: r.workspace_id,
        business_name: nameById.get(r.workspace_id) ?? null,
        opportunity_scan_enabled: r.opportunity_scan_enabled,
        business_insights_enabled: r.business_insights_enabled,
        last_opportunity_scan_at: r.last_opportunity_scan_at,
        last_business_insights_sent_at: r.last_business_insights_sent_at,
        // Both crons filter on these two before doing anything, so an enabled
        // flag here without them means "on, but will never fire."
        can_deliver: deliverable,
        ...(deliverable
          ? {}
          : {
              blocked_reason: !r.operator_whatsapp_number
                ? 'no operator_whatsapp_number set'
                : 'whatsapp_outbound_enabled is false',
            }),
      }
    })

    return { ok: true, data: { workspaces, count: workspaces.length } }
  },
}
