import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { hasSalesCapability } from '@/lib/sales/capability'
import type { Tool } from '../types'

interface ExpandOutreachTargetInput { vertical: string; region: string; rationale: string; evidence?: string; priority?: number }

/** Consequential, confirmation-gated change to the bounded sourcing universe. */
export const expandOutreachTarget: Tool<ExpandOutreachTargetInput> = {
  name: 'expand_outreach_target',
  description: 'Propose adding one new vertical and region to autonomous outreach sourcing after you have checked active targets and explained the supply constraint. This changes who Caye may contact, so the first call only stages an owner approval; do not claim it was applied until confirmation succeeds. Do not invent lead-volume estimates: use unknown when evidence cannot support a number.',
  risk: 'high', roles: ['owner', 'founder'], modes: ['back-office'],
  inputSchema: { type: 'object', properties: {
    vertical: { type: 'string', description: 'New business type, not already active.' },
    region: { type: 'string', description: 'New geography, not already active with this business type.' },
    rationale: { type: 'string', description: 'Why this is a fit and should improve lead supply.' },
    evidence: { type: 'string', description: 'Grounded evidence, or explicitly say unknown.' },
    priority: { type: 'number', description: 'Optional sourcing priority, lower runs earlier.' },
  }, required: ['vertical', 'region', 'rationale'] },
  async execute(args, ctx) {
    const vertical = args.vertical.trim(); const region = args.region.trim(); const rationale = args.rationale.trim()
    if (!vertical || !region || !rationale) return { ok: false, error: 'Vertical, region, and rationale are required.' }
    const db = createServiceClient()
    const { data: workspace } = await db.from('customers').select('workspace_kind').eq('id', ctx.workspaceId).maybeSingle()
    if (!hasSalesCapability(workspace)) return { ok: false, error: 'Outreach targeting is only available on an internal-sales workspace.' }
    const { data: existing, error: lookupError } = await db.from('outreach_sourcing_targets').select('id,active').eq('vertical', vertical).eq('region', region).maybeSingle()
    if (lookupError) return { ok: false, error: lookupError.message }
    if (existing?.active) return { ok: true, data: { changed: false, reason: 'target_already_active', target_id: existing.id } }
    const priority = Number.isInteger(args.priority) && args.priority! > 0 ? args.priority! : 100
    const { data, error } = await db.from('outreach_sourcing_targets').upsert({ vertical, region, priority, active: true, notes: `Approved expansion: ${rationale}${args.evidence ? ` Evidence: ${args.evidence}` : ''}` }, { onConflict: 'vertical,region' }).select('id,vertical,region,priority').single()
    if (error) return { ok: false, error: error.message }
    return { ok: true, data: { changed: true, target: data, rationale, evidence: args.evidence ?? 'unknown', next_step: 'Run outreach sourcing to measure net-new usable leads from this target.' } }
  },
}
