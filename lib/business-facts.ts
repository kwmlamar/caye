import 'server-only'
import { createServiceClient } from './supabase-server'

export interface BusinessFactRow {
  id: string
  category: 'policy' | 'service_detail' | 'special_handling' | 'logistics'
  fact: string
  memoryType?: string
  knowledgeMode?: string
  confidence?: number
  subjectType?: string
  subjectId?: string | null
}

/**
 * Retrieve current durable operating knowledge for the front desk through the
 * same workspace-bound typed-memory RPC used by the wider memory architecture.
 * This keeps the long-standing BUSINESS FACTS prompt contract while enforcing
 * temporal validity, supersession, sensitivity and workspace isolation in the
 * database rather than after a broad application-side read.
 *
 * Migration-safe fallback preserves the old query while environments roll
 * forward. The fallback remains workspace-scoped and excludes superseded and
 * expired rows, so a missing new RPC cannot broaden access.
 */
export async function fetchBusinessFacts(workspaceId: string): Promise<BusinessFactRow[]> {
  const supabase = createServiceClient()
  const { data, error } = await supabase.rpc('retrieve_operating_memory', {
    p_workspace_id: workspaceId,
    p_query: null,
    p_memory_types: ['fact', 'policy', 'procedure', 'correction', 'preference'],
    p_subject_type: null,
    p_subject_id: null,
    p_include_restricted: false,
    p_limit: 150,
  })

  if (!error) {
    return ((data ?? []) as Array<{
      id: string
      category: BusinessFactRow['category']
      fact: string
      memory_type: string
      knowledge_mode: string
      confidence: number
      subject_type: string
      subject_id: string | null
    }>).map((f) => ({
      id: f.id,
      category: f.category,
      fact: f.fact,
      memoryType: f.memory_type,
      knowledgeMode: f.knowledge_mode,
      confidence: f.confidence,
      subjectType: f.subject_type,
      subjectId: f.subject_id,
    }))
  }

  console.warn('[business-facts] typed retrieval unavailable, using legacy safe path:', error.message)
  const { data: legacy, error: legacyError } = await supabase
    .from('business_facts')
    .select('id, category, fact, expires_at')
    .eq('workspace_id', workspaceId)
    .is('superseded_at', null)
    .order('created_at', { ascending: true })
    .limit(150)
  if (legacyError) {
    console.error('[business-facts] fetch failed:', legacyError)
    return []
  }
  const now = Date.now()
  return ((legacy ?? []) as Array<BusinessFactRow & { expires_at: string | null }>)
    .filter((f) => !f.expires_at || new Date(f.expires_at).getTime() > now)
    .map(({ id, category, fact }) => ({ id, category, fact, subjectType: 'workspace', subjectId: null }))
}

/**
 * Render the BUSINESS FACTS block for the system prompt. Human-authored facts
 * remain authoritative; inferred material is explicitly marked as context so
 * one model judgment cannot silently become permanent policy. Typed subject
 * scope is rendered too: retaining scope in storage and then discarding it at
 * prompt assembly would simply recreate cross-scope memory leakage one layer
 * later.
 */
export function formatBusinessFactsBlock(facts: BusinessFactRow[]): string {
  if (facts.length === 0) return ''
  const byCat = new Map<string, string[]>()
  for (const f of facts) {
    if (!byCat.has(f.category)) byCat.set(f.category, [])
    const inferred = f.knowledgeMode === 'inferred' || f.knowledgeMode === 'derived'
    const inferencePrefix = inferred ? '[observed pattern, not policy] ' : ''
    const scoped = f.subjectType && f.subjectType !== 'workspace'
    const scopePrefix = scoped
      ? `[scope: ${f.subjectType}${f.subjectId ? ` ${f.subjectId}` : ''}; do not generalize] `
      : ''
    byCat.get(f.category)!.push(`${inferencePrefix}${scopePrefix}${f.fact}`)
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
    'BUSINESS FACTS — durable knowledge retrieved for this workspace. ' +
    'Explicit owner/operator corrections and policies are authoritative unless current system-of-record evidence contradicts them. ' +
    'Observed/inferred patterns are context only and never permission to invent or change policy. ' +
    'A scope label is a hard boundary: do not apply service/person/customer/project/property-scoped memory outside that subject.\n\n' +
    sections.join('\n\n')
  )
}
