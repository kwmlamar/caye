import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { loadScheduleConfig, localDateISO, endOfLocalDayUTC } from '@/lib/whatsapp/schedule'
import type { Tool } from '../types'

interface AddBusinessFactInput {
  category: 'policy' | 'service_detail' | 'special_handling' | 'logistics'
  fact: string
  expires_on?: string
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

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
    "fact (\"weather cancellations get a full refund or rebook\").\n\n" +
    "Set expires_on for anything that's only true temporarily — a vacation closure, a one-off " +
    "promotion. Once that date passes, Caye stops using the fact automatically (no need to " +
    "remember to remove it). Leave it out for anything evergreen.",
  risk: 'low',
  roles: ['owner', 'founder'],
  modes: ['back-office'],
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
      expires_on: {
        type: 'string',
        description: "Optional 'YYYY-MM-DD'. After this date Caye stops using the fact. Omit for evergreen facts.",
      },
    },
    required: ['category', 'fact'],
  },

  async execute(args, ctx) {
    const fact = args.fact.trim()
    if (fact.length < 5) return { ok: false, error: 'Fact is too short to be useful.' }
    if (fact.length > 800) return { ok: false, error: 'Fact is too long — keep it to one sentence.' }

    let expiresAt: string | undefined
    if (args.expires_on) {
      if (!ISO_DATE.test(args.expires_on)) {
        return { ok: false, error: "expires_on must be 'YYYY-MM-DD'." }
      }
      // Both the "is this in the past?" check and the stored instant resolve
      // in the WORKSPACE's timezone, not the server's UTC. Owner-facing dates
      // are always local dates: "closed through the 15th" has to keep the
      // fact alive for all of the 15th in Bimini, and "expires today" must
      // still be accepted at 9pm local (which is already tomorrow in UTC).
      const { timezone } = await loadScheduleConfig(ctx.workspaceId)
      const todayISO = localDateISO(new Date(), timezone)
      if (args.expires_on < todayISO) {
        return {
          ok: false,
          error: `${args.expires_on} is in the past (today is ${todayISO}) — check the year before retrying.`,
        }
      }
      expiresAt = endOfLocalDayUTC(args.expires_on, timezone).toISOString()
    }

    const supabase = createServiceClient()
    const { data, error } = await supabase
      .from('business_facts')
      .insert({
        workspace_id: ctx.workspaceId,
        category: args.category,
        fact,
        source: 'owner-direct',
        created_by: ctx.callerRole,
        ...(expiresAt ? { expires_at: expiresAt } : {}),
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
        expires_on: args.expires_on ?? null,
        created_at: data.created_at,
      },
    }
  },
}
