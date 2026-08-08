import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { Tool } from '../types'

interface RemoveStandingRuleInput {
  match_value: string
}

/**
 * Mirrors remove_business_fact. Soft delete (is_active = false) rather than
 * a hard delete: the row is the provenance record for a behaviour change on
 * a live workspace, and "why did Caye stop escalating these?" needs to stay
 * answerable after the fact.
 */
export const removeStandingRule: Tool<RemoveStandingRuleInput> = {
  name: 'remove_standing_rule',
  description:
    "Turn off a hard rule so Caye handles those messages normally again. Use when the owner says " +
    "to stop bringing something to them — \"you can quote the sunset charter yourself now\". " +
    "Match by the phrase the rule watches for; call list_standing_rules first if unsure of the wording.",
  risk: 'low',
  roles: ['owner', 'founder'],
  modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      match_value: {
        type: 'string',
        description: 'The phrase the rule watches for, as shown by list_standing_rules.',
      },
    },
    required: ['match_value'],
  },

  async execute(args, ctx) {
    const supabase = createServiceClient()
    const { data: found } = await supabase
      .from('caye_standing_rules')
      .select('id, match_value, times_fired')
      .eq('workspace_id', ctx.workspaceId)
      .eq('is_active', true)
      .ilike('match_value', args.match_value.trim())
      .maybeSingle()

    if (!found) {
      return { ok: false, error: `No active rule matching "${args.match_value}". Use list_standing_rules to see what's set.` }
    }

    const { error } = await supabase
      .from('caye_standing_rules')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('id', found.id)

    if (error) return { ok: false, error: `Could not remove the rule: ${error.message}` }

    return {
      ok: true,
      data: {
        removed: found.match_value,
        times_fired_while_active: found.times_fired,
        enforcement:
          'Caye will now handle these messages normally again — drafting replies, quoting, and booking as usual.',
      },
    }
  },
}
