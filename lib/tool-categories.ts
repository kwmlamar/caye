/**
 * Product-facing capability grouping for the founder's Tools inventory
 * (Operations → Tools). TOOL_REGISTRY (lib/caye-agent/tools/registry.ts)
 * is an engineering artifact — a flat list of ~80 tools grouped by risk
 * tier, which is exactly what an implementer needs and exactly what a
 * "what can Caye actually do" glance doesn't. This maps each tool's real
 * name to a capability a founder recognizes, so the primary Tools view
 * can lead with "Customer communication" / "Bookings" / etc. and let the
 * raw registry stay one click away for debugging.
 *
 * Keyword match against the tool's own snake_case name, first match
 * wins — deliberately loose rather than a hand-maintained exact-name
 * list, so a new tool lands in a sensible bucket by naming convention
 * alone instead of silently falling through to "Other" until someone
 * remembers to add it here.
 */

export interface ToolCategory {
  id: string
  label: string
}

const CATEGORIES: (ToolCategory & { match: RegExp })[] = [
  { id: 'communication', label: 'Customer communication', match: /reply|message|thread|held_queue|inbound|mark_handled|mute_caye|unmute_caye|internal_note|customer_history|get_customer\b/ },
  { id: 'bookings', label: 'Bookings & calendar', match: /booking|calendar|availability|blackout/ },
  { id: 'payments', label: 'Pricing & payments', match: /price|pricing|payment|revenue|quote/ },
  { id: 'knowledge', label: 'Business knowledge', match: /business_fact|fact_candidate|standing_rule|service|knowledge|business_hours/ },
  { id: 'voice', label: 'Voice & team', match: /voice|team_member/ },
  { id: 'outreach', label: 'Outreach', match: /outreach/ },
  { id: 'channels', label: 'Channels', match: /channel|connect_link/ },
  { id: 'scheduling', label: 'Scheduling & reminders', match: /reminder/ },
  { id: 'logistics', label: 'Driver & logistics', match: /driver|assignment|logistics/ },
  { id: 'operations', label: 'Operations', match: /cron|workspace_autonomy|switch_workspace|pending_action/ },
]

const FALLBACK: ToolCategory = { id: 'other', label: 'Other' }

export function categorizeTool(toolName: string): ToolCategory {
  const match = CATEGORIES.find((c) => c.match.test(toolName))
  return match ? { id: match.id, label: match.label } : FALLBACK
}

export interface CategorizedTool<T> {
  category: ToolCategory
  tools: T[]
}

/** Groups tools by capability, preserving CATEGORIES order, then "Other" last. */
export function groupToolsByCategory<T extends { name: string }>(tools: T[]): CategorizedTool<T>[] {
  const order = [...CATEGORIES.map((c) => ({ id: c.id, label: c.label })), FALLBACK]
  const buckets = new Map<string, T[]>()
  for (const tool of tools) {
    const { id } = categorizeTool(tool.name)
    buckets.set(id, [...(buckets.get(id) ?? []), tool])
  }
  return order
    .map((category) => ({ category, tools: buckets.get(category.id) ?? [] }))
    .filter((group) => group.tools.length > 0)
}
