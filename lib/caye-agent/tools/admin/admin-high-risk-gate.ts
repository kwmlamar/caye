import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { Tool, ToolContext, ToolResult } from '../types'
import { stableArgsKey } from '../high-risk-gate'

const PENDING_TTL_MINUTES = 15

function describeAdminPendingAction(toolName: string, args: Record<string, unknown>): string {
  if (toolName === 'trigger_cron') return `Run cron: ${args.cron_name}`
  return `Run ${toolName}`
}

/**
 * Admin-shell analog of gateHighRisk (lib/caye-agent/tools/high-risk-gate.ts)
 * — same code-enforced, requestId-based confirmation mechanism (stage on
 * first call, only execute when the same tool+args is seen again from a
 * DIFFERENT top-level request), but backed by caye_admin_pending_actions
 * instead of caye_pending_actions.
 *
 * Deliberately a separate table/gate rather than reusing gateHighRisk
 * directly: that table's workspace_id/operator_id columns are NOT NULL/FK
 * and scope every lookup, which doesn't fit admin-shell's workspace-less,
 * single-caller (founder-only) surface. Loosening those constraints on
 * the shared safety rail for customer-facing high-risk actions, just to
 * fit an unrelated dev/ops console, is out of scope here.
 */
export function gateAdminHighRisk<T>(tool: Tool<T>): Tool<T> {
  return {
    ...tool,
    async execute(args, ctx: ToolContext): Promise<ToolResult> {
      const supabase = createServiceClient()
      const argsKey = stableArgsKey(args)
      const nowISO = new Date().toISOString()

      const { data: existing } = await supabase
        .from('caye_admin_pending_actions')
        .select('id, created_in_request_id')
        .eq('tool_name', tool.name)
        .eq('args_key', argsKey)
        .is('executed_at', null)
        .is('cancelled_at', null)
        .gt('expires_at', nowISO)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      const summary = describeAdminPendingAction(tool.name, args as Record<string, unknown>)

      if (existing) {
        if (existing.created_in_request_id !== ctx.requestId) {
          const result = await tool.execute(args, ctx)
          await supabase
            .from('caye_admin_pending_actions')
            .update({ executed_at: new Date().toISOString(), result })
            .eq('id', existing.id)
          return result
        }
        return {
          ok: true,
          data: {
            pending: true,
            summary,
            note: 'Already staged this turn — relay the summary and stop. Do not call this tool again until the founder replies in a new message.',
          },
        }
      }

      const { error } = await supabase.from('caye_admin_pending_actions').insert({
        tool_name: tool.name,
        args,
        args_key: argsKey,
        summary,
        created_in_request_id: ctx.requestId,
        expires_at: new Date(Date.now() + PENDING_TTL_MINUTES * 60 * 1000).toISOString(),
      })
      if (error) {
        return { ok: false, error: `Could not stage this action: ${error.message}` }
      }

      return {
        ok: true,
        data: {
          pending: true,
          summary,
          expires_in_minutes: PENDING_TTL_MINUTES,
          note: 'Staged, not executed yet. Relay the summary and ask the founder to confirm. Once they reply affirmatively in a NEW message, call this same tool with the same arguments again to actually run it.',
        },
      }
    },
  } as Tool<T>
}
