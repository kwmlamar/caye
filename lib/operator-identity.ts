import 'server-only'
import type { createServiceClient } from '@/lib/supabase-server'

export interface OperatorIdentity {
  id: number
  name: string | null
  role: 'owner' | 'staff' | 'founder' | 'driver'
}

/**
 * Resolve an operator_allowlist row by phone, scoped to one workspace.
 * Used by broadcast crons (morning briefing, EOD summary) that send to a
 * single canonical number rather than reacting to an inbound message.
 */
export async function resolveOperatorByPhone(
  supabase: ReturnType<typeof createServiceClient>,
  workspaceId: string,
  phone: string
): Promise<OperatorIdentity | null> {
  const normalized = phone.replace(/^\+/, '')
  const { data } = await supabase
    .from('operator_allowlist')
    .select('id, name, role')
    .eq('workspace_id', workspaceId)
    .or(`phone.eq.${normalized},phone.eq.+${normalized}`)
    .limit(1)
    .maybeSingle()
  return (data as OperatorIdentity | null) ?? null
}

/**
 * Resolve the founder's own operator_allowlist row for a workspace — used
 * by the web-based Caye Direct route, where the caller is always the
 * founder (there's no phone to resolve; auth already proved who they are).
 */
export async function resolveFounderOperator(
  supabase: ReturnType<typeof createServiceClient>,
  workspaceId: string
): Promise<OperatorIdentity | null> {
  const { data } = await supabase
    .from('operator_allowlist')
    .select('id, name, role')
    .eq('workspace_id', workspaceId)
    .eq('role', 'founder')
    .limit(1)
    .maybeSingle()
  return (data as OperatorIdentity | null) ?? null
}
