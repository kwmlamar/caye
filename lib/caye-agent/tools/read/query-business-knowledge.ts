import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { Tool } from '../types'

interface QueryBusinessKnowledgeInput {
  question: string
  category?: 'policy' | 'service_detail' | 'special_handling' | 'logistics'
}

export interface FactRow {
  id: string
  category: string
  fact: string
  source: string
  created_at: string
  expires_at?: string | null
}

/**
 * v1 retrieval: lowercased term overlap. Pull all facts for the workspace
 * (small per-workspace counts make this cheap), score by question-term hits,
 * return the top matches. Embeddings + LLM rerank are the upgrade path when
 * fact volume justifies — flagged in the issue, not built for v1.
 */
function scoreFact(question: string, fact: string): number {
  const qTerms = question
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3)
  if (qTerms.length === 0) return 0
  const lowerFact = fact.toLowerCase()
  let score = 0
  for (const t of qTerms) if (lowerFact.includes(t)) score += 1
  return score
}

function createdAtMs(row: FactRow): number {
  const ms = Date.parse(row.created_at)
  return Number.isFinite(ms) ? ms : 0
}

/**
 * Rank relevant facts with recency as the deterministic tie-breaker.
 * Owner-taught knowledge evolves; when two equally-relevant facts conflict,
 * returning the newest first gives the model a stable precedence rule instead
 * of whatever row order Postgres happened to return that day.
 */
export function rankBusinessFacts(question: string, rows: FactRow[], now = Date.now()): FactRow[] {
  const active = rows.filter((row) => {
    if (!row.expires_at) return true
    const expires = Date.parse(row.expires_at)
    return !Number.isFinite(expires) || expires > now
  })

  const scored = active
    .map((row) => ({ row, score: scoreFact(question, row.fact) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || createdAtMs(b.row) - createdAtMs(a.row))
    .slice(0, 10)

  if (scored.length > 0) return scored.map((item) => item.row)

  return [...active]
    .sort((a, b) => createdAtMs(b) - createdAtMs(a))
    .slice(0, 5)
}

export const queryBusinessKnowledge: Tool<QueryBusinessKnowledgeInput> = {
  name: 'query_business_knowledge',
  description:
    "Look up what Caye knows about a topic from the business_facts knowledge base. Use when " +
    "the owner asks \"what do you know about X?\" / \"what's our policy on Y?\" — or when " +
    "you need to recall a previously-taught fact before answering a guest question.\n\n" +
    "Returns matching ACTIVE facts ordered by relevance, with newer facts first when relevance ties. " +
    "Owner-taught facts can change over time: if two owner-direct facts conflict, treat the newer one " +
    "as the current instruction unless the operator explicitly says otherwise in the current turn. " +
    "Empty result means Caye has no captured knowledge on that topic — say so plainly, don't fabricate.",
  risk: 'read',
  // Open to staff too — knowledge lookup is harmless.
  roles: ['owner', 'staff', 'founder'],
  // 'front-desk' added 2026-08-16 (Phase 2 of runtime convergence) — the
  // same business_facts read a customer-facing turn needs before answering
  // "do you do X" / "what's included" — reused, not duplicated.
  modes: ['back-office', 'front-desk'],
  inputSchema: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: 'The topic or question — natural language. e.g. "cancellation policy", "what to bring on the heritage tour".',
      },
      category: {
        type: 'string',
        enum: ['policy', 'service_detail', 'special_handling', 'logistics'],
        description: 'Optional filter to one category. Omit to search across all categories.',
      },
    },
    required: ['question'],
  },

  async execute(args, ctx) {
    const q = args.question.trim()
    if (q.length < 2) return { ok: false, error: 'Question is too short.' }

    const supabase = createServiceClient()
    let query = supabase
      .from('business_facts')
      .select('id, category, fact, source, created_at, expires_at')
      .eq('workspace_id', ctx.workspaceId)
      .order('created_at', { ascending: false })
    if (args.category) query = query.eq('category', args.category)

    const { data, error } = await query.limit(200)
    if (error) return { ok: false, error: error.message }

    const rows = (data ?? []) as FactRow[]
    const results = rankBusinessFacts(q, rows)
    const matched = results.filter((row) => scoreFact(q, row.fact) > 0).length

    return {
      ok: true,
      data: {
        question: q,
        matched,
        items: results.map((r) => ({
          fact_id: r.id,
          category: r.category,
          fact: r.fact,
          source: r.source,
          created_at: r.created_at,
        })),
      },
    }
  },
}
