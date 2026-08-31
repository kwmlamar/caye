import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'

export type CayeDirectActivityKind = 'thinking' | 'analyzing_image' | 'calling_tool' | 'completed' | 'failed'

export interface CayeDirectActivity {
  id: string
  workspace_id: string
  thread_id: string
  kind: CayeDirectActivityKind
  label: string | null
  tool_name: string | null
  updated_at: string
}

export async function startCayeDirectActivity(input: {
  workspaceId: string
  threadId: string
  kind: CayeDirectActivityKind
  label?: string | null
}): Promise<string | null> {
  try {
    const supabase = createServiceClient()
    const { data, error } = await supabase
      .from('caye_direct_turn_activity')
      .insert({
        workspace_id: input.workspaceId,
        thread_id: input.threadId,
        kind: input.kind,
        label: input.label ?? null,
      })
      .select('id')
      .single()
    if (error) {
      console.warn('[caye-direct-activity] start failed:', error.message)
      return null
    }
    return typeof data?.id === 'string' ? data.id : null
  } catch (err) {
    console.warn('[caye-direct-activity] start threw:', err)
    return null
  }
}

export async function updateCayeDirectActivity(
  id: string | null | undefined,
  patch: { kind: CayeDirectActivityKind; label?: string | null; toolName?: string | null }
): Promise<void> {
  if (!id) return
  try {
    const supabase = createServiceClient()
    const { error } = await supabase
      .from('caye_direct_turn_activity')
      .update({
        kind: patch.kind,
        label: patch.label ?? null,
        tool_name: patch.toolName ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
    if (error) console.warn('[caye-direct-activity] update failed:', error.message)
  } catch (err) {
    console.warn('[caye-direct-activity] update threw:', err)
  }
}

export async function latestCayeDirectActivity(workspaceId: string, threadId?: string | null): Promise<CayeDirectActivity | null> {
  const supabase = createServiceClient()
  let query = supabase
    .from('caye_direct_turn_activity')
    .select('id, workspace_id, thread_id, kind, label, tool_name, updated_at')
    .eq('workspace_id', workspaceId)
    .in('kind', ['thinking', 'analyzing_image', 'calling_tool'])
    .gte('updated_at', new Date(Date.now() - 10 * 60_000).toISOString())
  if (threadId) query = query.eq('thread_id', threadId)
  const { data, error } = await query.order('updated_at', { ascending: false }).limit(1).maybeSingle()
  if (error || !data) return null
  return data as CayeDirectActivity
}
