import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { ActionContext, ActionResult } from './types'

export async function actionUnmute(ctx: ActionContext): Promise<ActionResult> {
  const supabase = createServiceClient()
  await supabase
    .from('workspace_ai_config')
    .update({ whatsapp_muted_until: null })
    .eq('workspace_id', ctx.workspaceId)

  return {
    ackBody: "Back. I'll catch you up in the morning digest.",
    tag: { label: 'unmute', status: 'ok' },
  }
}
