import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { Tool } from '../types'

interface MuteCayeInput {
  duration_hours?: number
  until_iso?: string
}

const DEFAULT_MUTE_HOURS = 8

export const muteCaye: Tool<MuteCayeInput> = {
  name: 'mute_caye',
  description:
    "Pause Caye's customer auto-replies for a window. Default 8 hours if no duration given. Use when the operator says 'mute me' / 'shush for X hours' / 'quiet until tomorrow'.",
  risk: 'low',
  roles: ['owner', 'founder'],
  modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      duration_hours: {
        type: 'number',
        description: 'How many hours to mute. Defaults to 8.',
      },
      until_iso: {
        type: 'string',
        description: 'Optional absolute ISO timestamp to mute until. If provided, overrides duration_hours.',
      },
    },
  },

  async execute(args, ctx) {
    const supabase = createServiceClient()
    let until: Date
    if (args.until_iso) {
      const parsed = new Date(args.until_iso)
      if (Number.isNaN(parsed.getTime())) {
        return { ok: false, error: "Couldn't parse until_iso. Use ISO 8601." }
      }
      until = parsed
    } else {
      const hours = args.duration_hours && args.duration_hours > 0
        ? args.duration_hours
        : DEFAULT_MUTE_HOURS
      until = new Date(Date.now() + hours * 60 * 60 * 1000)
    }

    const { error } = await supabase
      .from('workspace_ai_config')
      .update({ whatsapp_muted_until: until.toISOString() })
      .eq('workspace_id', ctx.workspaceId)
    if (error) return { ok: false, error: error.message }

    return {
      ok: true,
      data: {
        muted_until: until.toISOString(),
        hours_from_now: Math.round((until.getTime() - Date.now()) / (60 * 60 * 1000)),
      },
    }
  },
}
