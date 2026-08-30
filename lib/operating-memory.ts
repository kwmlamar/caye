import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'

export type OperatingMemoryType =
  | 'fact'
  | 'preference'
  | 'procedure'
  | 'policy'
  | 'decision'
  | 'correction'
  | 'operating_pattern'
  | 'outcome'
  | 'assumption'
  | 'prior_work'

export interface OperatingMemory {
  id: string
  memory_type: OperatingMemoryType
  subject_type: string
  subject_id: string | null
  category: string
  fact: string
  canonical_key: string | null
  confidence: number
  knowledge_mode: 'explicit' | 'observed' | 'inferred' | 'derived'
  authority_kind: string
  source: string
  provenance: Record<string, unknown>
  valid_from: string
  valid_until: string | null
  created_at: string
  relevance: number
}

/**
 * Durable operating-memory retrieval. This is deliberately workspace-bound
 * at the database RPC, not filtered in application memory after a broad read.
 * Restricted memory is opt-in and private memory is never returned by this
 * generic operator-context path.
 */
export async function loadOperatingMemory(args: {
  workspaceId: string
  query?: string | null
  memoryTypes?: OperatingMemoryType[] | null
  subjectType?: string | null
  subjectId?: string | null
  includeRestricted?: boolean
  limit?: number
}): Promise<OperatingMemory[]> {
  const supabase = createServiceClient()
  const { data, error } = await supabase.rpc('retrieve_operating_memory', {
    p_workspace_id: args.workspaceId,
    p_query: args.query?.trim() || null,
    p_memory_types: args.memoryTypes ?? null,
    p_subject_type: args.subjectType ?? null,
    p_subject_id: args.subjectId ?? null,
    p_include_restricted: args.includeRestricted === true,
    p_limit: args.limit ?? 24,
  })

  if (error) {
    // Migration-safe failure posture: memory enrichment must never take down
    // the operator runtime while environments roll forward independently.
    console.warn('[operating-memory] retrieval failed:', error.message)
    return []
  }
  return (data ?? []) as OperatingMemory[]
}

export function renderOperatingMemory(memories: OperatingMemory[]): string | null {
  if (memories.length === 0) return null

  const safe = memories.filter((m) => {
    if (!m.fact?.trim()) return false
    if (!Number.isFinite(Number(m.confidence))) return false
    if (m.confidence < 0 || m.confidence > 1) return false
    return true
  })
  if (safe.length === 0) return null

  const lines = safe.map((m) => {
    const subject = m.subject_id ? `${m.subject_type}:${m.subject_id}` : m.subject_type
    const epistemic = `${m.knowledge_mode}, confidence ${Number(m.confidence).toFixed(2)}, authority ${m.authority_kind}`
    return `- [${m.memory_type}; ${subject}; ${epistemic}] ${m.fact}`
  })

  return [
    'DURABLE OPERATING MEMORY — retrieved for this workspace and current turn',
    '- Treat explicit human corrections/policies as stronger than inferred patterns or assumptions.',
    '- Inferred/derived memories are context, not permission to create or change policy.',
    '- Current authoritative tool/system state beats memory when they conflict; memory may be stale despite temporal filtering.',
    '- Never generalize a customer/service/person-scoped memory beyond its subject.',
    ...lines,
  ].join('\n')
}
