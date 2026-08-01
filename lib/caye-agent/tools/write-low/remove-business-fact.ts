import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { Tool } from '../types'

interface RemoveBusinessFactInput {
  match: string
}

export const removeBusinessFact: Tool<RemoveBusinessFactInput> = {
  name: 'remove_business_fact',
  description:
    "Remove a previously-saved business fact so Caye stops using it in guest replies. " +
    "Match by any unique substring of the fact text (e.g. \"vacation\", \"payment confirmation " +
    "will be a few days behind\"). Use this to retire facts that were only ever meant to be " +
    "temporary — a vacation note, a one-off promotion — once they're no longer true. " +
    "Errors when multiple facts match — be more specific.",
  risk: 'low',
  roles: ['owner', 'founder'],
  modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      match: {
        type: 'string',
        description: 'A unique substring of the fact to remove.',
      },
    },
    required: ['match'],
  },

  async execute(args, ctx) {
    const m = args.match.trim().toLowerCase()
    if (m.length < 3) return { ok: false, error: 'Match text is too short — be more specific.' }

    const supabase = createServiceClient()
    const { data: facts, error: fetchError } = await supabase
      .from('business_facts')
      .select('id, category, fact')
      .eq('workspace_id', ctx.workspaceId)

    if (fetchError) return { ok: false, error: fetchError.message }
    const current = facts ?? []
    if (current.length === 0) {
      return { ok: false, error: 'No business facts saved for this workspace.' }
    }

    const matches = current.filter((f) => f.fact.toLowerCase().includes(m))
    if (matches.length === 0) {
      return { ok: false, error: `No fact matches "${args.match}".` }
    }
    if (matches.length > 1) {
      return {
        ok: false,
        error: `Multiple facts match "${args.match}" — be more specific.`,
        data: { matches: matches.map((f) => f.fact) },
      }
    }

    const removed = matches[0]
    const { error } = await supabase.from('business_facts').delete().eq('id', removed.id)
    if (error) return { ok: false, error: error.message }

    return {
      ok: true,
      data: {
        removed: removed.fact,
        category: removed.category,
        remaining: current.length - 1,
      },
    }
  },
}
