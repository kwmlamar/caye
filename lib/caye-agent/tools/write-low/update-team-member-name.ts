import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { Tool } from '../types'

interface UpdateTeamMemberNameInput {
  name: string
}

export const updateTeamMemberName: Tool<UpdateTeamMemberNameInput> = {
  name: 'update_team_member_name',
  description:
    "Change how Caye addresses the caller in greetings and messages. Use when the operator " +
    "says something like \"call me Mrs. Max\" or \"my name should just be Karenda\". Always " +
    "updates the CALLER's own operator_allowlist row — there's no way to rename someone else " +
    "through this tool (use add_team_member's name at creation time, or ask them to rename " +
    "themselves).",
  risk: 'low',
  roles: ['owner', 'staff', 'founder'],
  modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The name/nickname Caye should use going forward, e.g. "Mrs. Max".' },
    },
    required: ['name'],
  },

  async execute(args, ctx) {
    const name = args.name.trim()
    if (name.length < 1) return { ok: false, error: 'Name is required.' }
    if (!ctx.operatorId) {
      return { ok: false, error: "Can't identify who's asking — no operator on this request." }
    }

    const supabase = createServiceClient()
    const { data: target } = await supabase
      .from('operator_allowlist')
      .select('id, name')
      .eq('id', ctx.operatorId)
      .eq('workspace_id', ctx.workspaceId)
      .maybeSingle()
    if (!target) return { ok: false, error: 'Could not find your operator record.' }

    const { error } = await supabase
      .from('operator_allowlist')
      .update({ name })
      .eq('id', target.id)
    if (error) return { ok: false, error: error.message }

    return {
      ok: true,
      data: { previous_name: target.name, new_name: name },
    }
  },
}
