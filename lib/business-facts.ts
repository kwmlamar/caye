import 'server-only'
import { createServiceClient } from './supabase-server'

export interface BusinessFactRow {
  id: string
  category: 'policy' | 'service_detail' | 'special_handling' | 'logistics'
  fact: string
}

/**
 * Pull every business fact for a workspace. Per-workspace counts stay small
 * in v1 (one operator's accumulated knowledge), so we hand the LLM the full
 * list rather than running a similarity search — same shape the operator's
 * voice profile uses.
 *
 * Goes in the DYNAMIC system block (not the cached prefix) because facts
 * change whenever the owner adds one — invalidating the cached prefix on
 * every fact-add would defeat the #46 cache strategy.
 */
export async function fetchBusinessFacts(workspaceId: string): Promise<BusinessFactRow[]> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('business_facts')
    .select('id, category, fact')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: true })
    .limit(150)
  if (error) {
    console.error('[business-facts] fetch failed:', error)
    return []
  }
  return (data ?? []) as BusinessFactRow[]
}

/**
 * Render the BUSINESS FACTS block for the system prompt. Empty string when
 * the workspace has none — adding "(no facts captured)" would just be noise.
 */
export function formatBusinessFactsBlock(facts: BusinessFactRow[]): string {
  if (facts.length === 0) return ''
  const byCat = new Map<string, string[]>()
  for (const f of facts) {
    if (!byCat.has(f.category)) byCat.set(f.category, [])
    byCat.get(f.category)!.push(f.fact)
  }
  const sections: string[] = []
  const order: BusinessFactRow['category'][] = ['policy', 'service_detail', 'special_handling', 'logistics']
  const labels: Record<BusinessFactRow['category'], string> = {
    policy: 'POLICIES',
    service_detail: 'SERVICE DETAILS',
    special_handling: 'SPECIAL HANDLING',
    logistics: 'LOGISTICS',
  }
  for (const cat of order) {
    const items = byCat.get(cat)
    if (!items?.length) continue
    sections.push(`${labels[cat]}:\n` + items.map((f) => `- ${f}`).join('\n'))
  }
  return (
    'BUSINESS FACTS — what the owner has taught you about this business. ' +
    'Treat these as authoritative. When a guest asks something a fact answers, ' +
    'use the fact directly — do not escalate just because there is no tool for it.\n\n' +
    sections.join('\n\n')
  )
}
