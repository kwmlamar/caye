import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { Tool } from '../types'

interface AddBusinessFactInput {
  category: 'policy' | 'service_detail' | 'special_handling' | 'logistics'
  fact: string
}

export const addBusinessFact: Tool<AddBusinessFactInput> = {
  name: 'add_business_fact',
  description:
    "Save a piece of business knowledge so Caye remembers it for future guest replies. " +
    "Use when the owner tells you something the business does, doesn't do, or how it handles " +
    "specific situations — e.g. \"we don't run tours when it rains\", \"the meeting point " +
    "for the heritage tour is the pink building by the dock\", \"if a guest says they're " +
    "celebrating, comp them a cocktail\".\n\n" +
    "Pick the category carefully — it drives later retrieval and the promotion loop:\n" +
    "- policy: rules / conditions / what we will or won't do (refunds, weather, no-shows).\n" +
    "- service_detail: specifics about a tour or service that aren't already in the catalog " +
    "(inclusions, what to bring, who it's not suitable for).\n" +
    "- special_handling: guest-segment rules (VIPs, repeat guests, complimentary asks).\n" +
    "- logistics: meeting points, parking, dock access, where to find us.\n\n" +
    "Write the fact as a complete standalone sentence — it will be shown out of context to " +
    "future-Caye and must read clearly. Don't write \"yes\" or \"sure\" — capture the actual " +
    "fact (\"weather cancellations get a full refund or rebook\").",
  risk: 'low',
  roles: ['owner', 'founder'],
  inputSchema: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        enum: ['policy', 'service_detail', 'special_handling', 'logistics'],
        description: 'Pick the best fit — see the descriptions in the tool overview.',
      },
      fact: {
        type: 'string',
        description: 'The fact as a complete standalone sentence. Will be shown to future-Caye verbatim.',
      },
    },
    required: ['category', 'fact'],
  },

  async execute(args, ctx) {
    const fact = args.fact.trim()
    if (fact.length < 5) return { ok: false, error: 'Fact is too short to be useful.' }
    if (fact.length > 800) return { ok: false, error: 'Fact is too long — keep it to one sentence.' }

    const supabase = createServiceClient()
    const { data, error } = await supabase
      .from('business_facts')
      .insert({
        workspace_id: ctx.workspaceId,
        category: args.category,
        fact,
        source: 'owner-direct',
        created_by: ctx.callerRole,
      })
      .select('id, created_at')
      .single()

    if (error) return { ok: false, error: error.message }
    return {
      ok: true,
      data: {
        fact_id: data.id,
        category: args.category,
        fact,
        created_at: data.created_at,
      },
    }
  },
}
