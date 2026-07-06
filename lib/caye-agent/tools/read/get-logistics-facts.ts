import 'server-only'
import { fetchBusinessFacts } from '@/lib/business-facts'
import type { Tool } from '../types'

interface GetLogisticsFactsInput {
  /** noop — kept so the tool always has a valid (empty) input schema */
}

/**
 * Driver-mode tool (2026-07-05): general logistics questions (meeting
 * point details, office contact) that aren't tied to a specific booking.
 *
 * Deliberately scoped to the `logistics` category only — drivers never
 * see policy/pricing/special_handling facts. Per-workspace fact counts
 * are small (same assumption fetchBusinessFacts already makes), so this
 * just hands over the full logistics list rather than doing retrieval.
 */
export const getLogisticsFacts: Tool<GetLogisticsFactsInput> = {
  name: 'get_logistics_facts',
  description:
    'Look up general logistics info the owner has taught Caye — meeting points, office contact ' +
    'numbers, that kind of thing. Use for questions not tied to a specific booking.',
  risk: 'read',
  roles: ['driver'],
  modes: ['driver'],
  inputSchema: { type: 'object', properties: {} },

  async execute(_args, ctx) {
    const facts = await fetchBusinessFacts(ctx.workspaceId)
    const logistics = facts.filter((f) => f.category === 'logistics')
    return {
      ok: true,
      data: { facts: logistics.map((f) => f.fact) },
    }
  },
}
