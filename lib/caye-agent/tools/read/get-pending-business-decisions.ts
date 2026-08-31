import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { Tool } from '../types'

export const getPendingBusinessDecisions: Tool<Record<string, never>> = {
  name: 'get_pending_business_decisions',
  description: 'List unresolved business decisions currently routed to this operator. Use this when an operator replies with a decision such as yes/no/approve/decline so you can ground their answer in the exact pending decision instead of guessing from conversation order.',
  risk: 'read',
  roles: ['owner', 'staff', 'founder'],
  modes: ['back-office'],
  inputSchema: { type: 'object', properties: {} },
  async execute(_args, ctx) {
    if (ctx.operatorId == null) return { ok: true, data: { decisions: [] } }
    const supabase = createServiceClient()
    const { data, error } = await supabase
      .from('caye_owner_attention')
      .select('id,title,decision_domain,required_authority,decision_risk,decision_requested_at,decision_expires_at,decision_evidence,decision_resume_link')
      .eq('workspace_id', ctx.workspaceId)
      .eq('subject_type', 'decision')
      .eq('decision_owner_operator_id', ctx.operatorId)
      .is('decided_at', null)
      .in('status', ['open', 'acknowledged'])
      .order('decision_requested_at', { ascending: false })
      .limit(20)
    if (error) return { ok: false, error: `Could not load pending decisions: ${error.message}` }

    const now = Date.now()
    const decisions = (data ?? []).filter((row) => {
      const expiresAt = row.decision_expires_at as string | null
      return !expiresAt || Date.parse(expiresAt) > now
    }).map((row) => ({
      id: row.id,
      summary: row.title,
      domain: row.decision_domain,
      required_authority: row.required_authority,
      risk: row.decision_risk,
      requested_at: row.decision_requested_at,
      expires_at: row.decision_expires_at,
      pending_action_id: (row.decision_evidence as { pendingActionId?: unknown } | null)?.pendingActionId ?? null,
      resume_link: row.decision_resume_link,
    }))
    return { ok: true, data: { decisions } }
  },
}
