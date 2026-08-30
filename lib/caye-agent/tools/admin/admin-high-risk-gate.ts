import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { Tool, ToolContext, ToolResult } from '../types'
import { stableArgsKey } from '../high-risk-gate'

const PENDING_TTL_MINUTES = 15

function describeAdminPendingAction(toolName: string, args: Record<string, unknown>): string {
  if (toolName === 'trigger_cron') return `Run cron: ${args.cron_name}`
  if (toolName === 'enable_application_automation') return 'Enable real ATS application-submission automation'
  if (toolName === 'disable_dry_run_mode') return 'Disable dry-run mode — real submissions can reach an ATS'
  if (toolName === 'set_daily_submission_cap') return `Set daily ATS submission cap to ${args.cap}`
  return `Run ${toolName}`
}

/**
 * These founder job-search operations cannot submit or contact an employer:
 * sourcing reads public boards, preparation writes internal readiness state,
 * and inspection reads public ATS form metadata plus verified founder facts.
 * Consequential ATS execution remains behind the separate confirmation gate.
 */
function canExecuteWithoutConfirmation(toolName: string, args: unknown): boolean {
  if (toolName !== 'trigger_cron' || !args || typeof args !== 'object') return false
  const cronName = (args as { cron_name?: unknown }).cron_name
  return cronName === 'job-search-sourcing' || cronName === 'job-search-prepare' || cronName === 'job-search-inspect'
}

export function gateAdminHighRisk<T>(tool: Tool<T>): Tool<T> {
  return {
    ...tool,
    async execute(args, ctx: ToolContext): Promise<ToolResult> {
      if (canExecuteWithoutConfirmation(tool.name, args)) return tool.execute(args, ctx)

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
          await supabase.from('caye_admin_pending_actions').update({ executed_at: new Date().toISOString(), result }).eq('id', existing.id)
          return result
        }
        return { ok: true, data: { pending: true, summary, note: 'Already staged this turn — relay the summary and stop. Do not call this tool again until the founder replies in a new message.' } }
      }

      const { error } = await supabase.from('caye_admin_pending_actions').insert({
        tool_name: tool.name,
        args,
        args_key: argsKey,
        summary,
        created_in_request_id: ctx.requestId,
        expires_at: new Date(Date.now() + PENDING_TTL_MINUTES * 60 * 1000).toISOString(),
      })
      if (error) return { ok: false, error: `Could not stage this action: ${error.message}` }
      return { ok: true, data: { pending: true, summary, expires_in_minutes: PENDING_TTL_MINUTES, note: 'Staged, not executed yet. Relay the summary and ask the founder to confirm. Once they reply affirmatively in a NEW message, call this same tool with the same arguments again to actually run it.' } }
    },
  } as Tool<T>
}
