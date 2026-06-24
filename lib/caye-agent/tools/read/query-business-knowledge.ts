import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { Tool } from '../types'

interface QueryBusinessKnowledgeInput {
  question: string
  category?: 'policy' | 'service_detail' | 'special_handling' | 'logistics'
}

interface FactRow {
  id: string
  category: string
  fact: string
  source: string
  created_at: string
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

export const queryBusinessKnowledge: Tool<QueryBusinessKnowledgeInput> = {
  name: 'query_business_knowledge',
  description:
    "Look up what Caye knows about a topic from the business_facts knowledge base. Use when " +
    "the owner asks \"what do you know about X?\" / \"what's our policy on Y?\" — or when " +
    "you need to recall a previously-taught fact before answering a guest question.\n\n" +
    "Returns matching facts ordered by relevance. Empty result means Caye has no captured " +
    "knowledge on that topic — say so plainly, don't fabricate.",
  risk: 'read',
  // Open to staff too — knowledge lookup is harmless.
  roles: ['owner', 'staff', 'founder'],
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
      .select('id, category, fact, source, created_at')
      .eq('workspace_id', ctx.workspaceId)
    if (args.category) query = query.eq('category', args.category)

    const { data, error } = await query.limit(200)
    if (error) return { ok: false, error: error.message }

    const rows = (data ?? []) as FactRow[]
    const scored = rows
      .map((r) => ({ row: r, score: scoreFact(q, r.fact) }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)

    // When nothing scored, fall back to the most-recent facts in the
    // category (or any category) — gives Caye SOMETHING to reason over
    // instead of "no results" when the owner phrases the question
    // differently than the fact was captured.
    const results =
      scored.length > 0
        ? scored.map((s) => s.row)
        : rows.slice(0, 5)

    return {
      ok: true,
      data: {
        question: q,
        matched: scored.length,
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
