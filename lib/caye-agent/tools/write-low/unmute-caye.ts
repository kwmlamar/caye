import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { Tool } from '../types'

export const unmuteCaye: Tool<Record<string, never>> = {
  name: 'unmute_caye',
  description:
    "Resume Caye's customer auto-replies after a mute. Use when the operator says 'unmute' / 'back on' / 'resume'.",
  risk: 'low',
  inputSchema: {
    type: 'object',
    properties: {},
  },

  async execute(_args, ctx) {
    const supabase = createServiceClient()
    const { error } = await supabase
      .from('workspace_ai_config')
      .update({ whatsapp_muted_until: null })
      .eq('workspace_id', ctx.workspaceId)
    if (error) return { ok: false, error: error.message }
    return { ok: true, data: { muted: false } }
  },
}
