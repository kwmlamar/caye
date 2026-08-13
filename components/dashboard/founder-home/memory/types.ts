// Mirrors exactly what /api/founder/memory returns — see that route's doc
// comment for the underlying tables. Nothing here is invented: every
// field is a real column (or, for learned_occurrence_count, a real join
// the route performs server-side).

export type FactCategory = 'policy' | 'service_detail' | 'special_handling' | 'logistics'
export type FactSource = 'owner-direct' | 'escalation-capture' | 'candidate-confirmed'

export interface Fact {
  id: string
  category: FactCategory
  fact: string
  source: FactSource
  created_at: string
  /** Real occurrence_count from the business_fact_candidates row this
   *  fact resolved from, when source is 'candidate-confirmed'. null for
   *  anything taught directly — there's no "N conversations" story for
   *  those. */
  learned_occurrence_count: number | null
}

export interface Rule {
  id: string
  trigger_type: 'service_mention' | 'keyword'
  match_value: string
  action: 'escalate'
  route_to: 'owner' | 'founder' | 'both'
  is_active: boolean
  times_fired: number
  last_fired_at: string | null
}

/** A pattern Caye has noticed repeating across conversations, proposed
 *  to the owner, not yet confirmed/corrected/dismissed — genuinely open,
 *  not a fabricated conflict. */
export interface Candidate {
  id: string
  sample_text: string
  category_guess: FactCategory
  occurrence_count: number
  first_seen_at: string
  proposed_at: string | null
}

export interface MemoryData {
  facts: Fact[]
  rules: Rule[]
  candidates: Candidate[]
}

export const CATEGORY_LABEL: Record<FactCategory, string> = {
  policy: 'Policies',
  service_detail: 'Service details',
  special_handling: 'Special handling',
  logistics: 'Logistics',
}
export const CATEGORY_ORDER: FactCategory[] = ['policy', 'service_detail', 'special_handling', 'logistics']
