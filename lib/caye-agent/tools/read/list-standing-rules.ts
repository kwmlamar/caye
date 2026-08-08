import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { Tool } from '../types'

/**
 * Ships in the same phase as add_standing_rule, deliberately. A rule the
 * owner can create but not see or remove is write-only memory — an
 * accumulating pile of invisible behaviour, which is the same class of
 * problem as a config field nobody reads (brief §5.3).
 */
export const listStandingRules: Tool<Record<string, never>> = {
  name: 'list_standing_rules',
  description:
    "Show the hard rules currently enforced for this workspace — the things Caye always brings to " +
    "the owner instead of handling alone. Use when the owner asks what rules are set, what you " +
    "always escalate, or why something got sent to them. Also worth checking before adding a new " +
    "rule, to avoid near-duplicates.",
  risk: 'read',
  roles: ['owner', 'founder'],
  modes: ['back-office'],
  inputSchema: { type: 'object', properties: {} },

  async execute(_args, ctx) {
    const supabase = createServiceClient()
    const { data, error } = await supabase
      .from('caye_standing_rules')
      .select('id, trigger_type, match_value, route_to, times_fired, last_fired_at, created_at')
      .eq('workspace_id', ctx.workspaceId)
      .eq('is_active', true)
      .order('created_at', { ascending: true })

    if (error) return { ok: false, error: `Could not read the rules: ${error.message}` }

    const rules = (data ?? []) as Array<{
      id: string
      match_value: string
      times_fired: number
      last_fired_at: string | null
      created_at: string
    }>

    if (rules.length === 0) {
      return {
        ok: true,
        data: {
          rules: [],
          note: 'No hard rules set. Everything is handled by normal judgment plus the saved business facts.',
        },
      }
    }

    // Surface the staleness signal rather than making the model derive it.
    const ninetyDaysAgo = Date.now() - 90 * 24 * 60 * 60 * 1000
    return {
      ok: true,
      data: {
        rules: rules.map((r) => ({
          ...r,
          never_fired: r.times_fired === 0,
          possibly_stale:
            r.times_fired === 0 && new Date(r.created_at).getTime() < ninetyDaysAgo,
        })),
        note: 'Rules marked possibly_stale have never fired since being set over 90 days ago — worth asking the owner if they still want them.',
      },
    }
  },
}
