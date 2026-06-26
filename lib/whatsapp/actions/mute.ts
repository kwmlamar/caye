import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { ActionContext, ActionResult } from './types'

const DEFAULT_MUTE_HOURS = 8

export async function actionMute(
  ctx: ActionContext,
  intent: { duration_hours?: number; until_iso?: string }
): Promise<ActionResult> {
  let until: Date
  if (intent.until_iso) {
    const parsed = new Date(intent.until_iso)
    if (Number.isNaN(parsed.getTime())) {
      return {
        ackBody: "Couldn't parse the mute time. Try 'mute 2h' or 'mute 24h'.",
        tag: { label: 'mute', status: 'failed' },
      }
    }
    until = parsed
  } else {
    const hours = intent.duration_hours && intent.duration_hours > 0 ? intent.duration_hours : DEFAULT_MUTE_HOURS
    until = new Date(Date.now() + hours * 60 * 60 * 1000)
  }

  const supabase = createServiceClient()
  const { error } = await supabase
    .from('workspace_ai_config')
    .update({ whatsapp_muted_until: until.toISOString() })
    .eq('workspace_id', ctx.workspaceId)

  if (error) {
    console.error('[action/mute] DB update failed:', error)
    return {
      ackBody: `Couldn't apply the mute — ${error.message}.`,
      tag: { label: 'mute', status: 'failed' },
    }
  }

  return {
    ackBody: `Muted until ${formatRelative(until)}. Auth failures still ping. Reply 'unmute' anytime.`,
    tag: { label: 'mute', status: 'ok' },
  }
}

function formatRelative(when: Date): string {
  const diffH = Math.round((when.getTime() - Date.now()) / (60 * 60 * 1000))
  if (diffH < 24) return `${diffH}h from now`
  const days = Math.round(diffH / 24)
  return `${days} day${days === 1 ? '' : 's'} from now`
}
