import 'server-only'
import type { createServiceClient } from '@/lib/supabase-server'
import type { RichResult } from './caye-direct-rich-results'

/** Resolves reference labels/status from Caye's records; model text has no authority here. */
export async function resolveRichResultReferences(supabase: ReturnType<typeof createServiceClient>, workspaceId: string, result: RichResult | null | undefined): Promise<RichResult | null | undefined> {
  if (!result) return result
  const blocks = await Promise.all(result.blocks.map(async block => {
    if (block.type === 'goal_reference') {
      const { data } = await supabase.from('caye_goals').select('title,status').eq('id', block.id).or(`workspace_id.eq.${workspaceId},scope.eq.operator`).maybeSingle()
      return data ? { ...block, resolved: { title: String(data.title), status: String(data.status) } } : block
    }
    if (block.type === 'work_reference') {
      const { data } = await supabase.from('caye_work_opportunities').select('description,status').eq('id', block.id).eq('workspace_id', workspaceId).maybeSingle()
      return data ? { ...block, resolved: { title: String(data.description), status: String(data.status) } } : block
    }
    return block
  }))
  return { ...result, blocks }
}
