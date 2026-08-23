import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { hasSalesCapability } from '@/lib/sales/capability'
import type { Tool } from '../types'

/** Grounded context for expansion recommendations; never asks the model to guess active markets. */
export const getOutreachTargeting: Tool<Record<string, never>> = {
  name: 'get_outreach_targeting',
  description: 'Get the active outreach geographies and business types before recommending an expansion. Always call this before proposing a new outreach target; never present an already-active target as new.',
  risk: 'read', roles: ['owner', 'founder'], modes: ['back-office'],
  inputSchema: { type: 'object', properties: {} },
  async execute(_args, ctx) {
    const db = createServiceClient()
    const { data: workspace } = await db.from('customers').select('workspace_kind').eq('id', ctx.workspaceId).maybeSingle()
    if (!hasSalesCapability(workspace)) return { ok: false, error: 'Outreach targeting is only available on an internal-sales workspace.' }
    const { data, error } = await db.from('outreach_sourcing_targets').select('id,vertical,region,priority,last_sourced_at,notes').eq('active', true).order('priority')
    if (error) return { ok: false, error: error.message }
    return { ok: true, data: { active_targets: data ?? [] } }
  },
}
