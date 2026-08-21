import 'server-only'
import Anthropic from '@anthropic-ai/sdk'
import { createServiceClient } from '@/lib/supabase-server'
import { loggedMessagesCreate } from '@/lib/llm-telemetry'

export type LearnedKnowledgeType = 'business_fact' | 'procedure' | 'operator_preference' | 'constraint'
export type LearnedKnowledgeStatus = 'candidate' | 'confirmed' | 'active' | 'superseded'

export interface LearnedOperatingKnowledge {
  id: string
  knowledge_type: LearnedKnowledgeType
  status: LearnedKnowledgeStatus
  scope: Record<string, unknown>
  trigger: { when?: string; conditions?: string[] }
  behavior: { do?: string[]; avoid?: string[]; requires_authoritative_state?: string[] }
  rationale: string | null
  source_excerpt?: string
  promotion_reason?: string | null
  superseded_by?: string | null
  supersedes?: { id: string; source_excerpt: string }[]
}

export interface CorrectionCandidate {
  learnable: boolean
  reusable: boolean
  knowledgeType: LearnedKnowledgeType
  scope: Record<string, unknown>
  trigger: { when: string; conditions: string[] }
  behavior: { do: string[]; avoid: string[]; requires_authoritative_state: string[] }
  rationale: string
  canonicalKey: string
  confidence: number
  riskLevel: 'low' | 'consequential'
  explicitDurable: boolean
  oneOff: boolean
}

const ONE_OFF = /\b(?:for\s+[A-Z][\w'-]+\s+only|this (?:guest|customer|booking|time) only|just (?:for|this)\b)\b/i
const DURABLE = /\b(?:always|from now on|going forward|for (?:all |every )?\w+ (?:guests?|customers?|bookings?)|whenever|each time|never)\b/i
const CORRECTION_CUE = /\b(?:need (?:them|you|it|the message)|should|make sure|instead|not like that|don't|do not|always|never|from now on|going forward|the point is|i mean)\b/i

export function obviousOneOffInstruction(text: string): boolean {
  return ONE_OFF.test(text)
}

export function hasExplicitDurableScope(text: string): boolean {
  return DURABLE.test(text)
}

export function plausiblyReusableCorrection(text: string, previousCayeText: string | null): boolean {
  return !!previousCayeText && text.length >= 12 && CORRECTION_CUE.test(text) && !obviousOneOffInstruction(text)
}

export function decideInitialStatus(candidate: CorrectionCandidate): { status: LearnedKnowledgeStatus; reason: string } {
  if (!candidate.learnable || !candidate.reusable || candidate.oneOff) return { status: 'candidate', reason: 'not_reusable' }
  if (candidate.knowledgeType === 'business_fact') return { status: 'candidate', reason: 'objective_fact_requires_existing_fact_confirmation_boundary' }
  if (candidate.riskLevel === 'consequential') return { status: 'candidate', reason: 'consequential_requires_confirmation' }
  if (candidate.explicitDurable && candidate.confidence >= 0.85) return { status: 'active', reason: 'explicit_unambiguous_low_risk_instruction' }
  return { status: 'candidate', reason: 'single_correction_requires_repetition_or_confirmation' }
}

export function formatLearnedOperatingKnowledge(rows: LearnedOperatingKnowledge[]): string {
  const active = rows.filter((r) => r.status === 'active')
  if (!active.length) return ''
  return `LEARNED OPERATING PROCEDURES — authorized workspace guidance about HOW to work.\n+Use it when its conditions fit, including analogous cases with different names or wording. It is not evidence for booking-specific or current objective facts. Times, people, prices, meeting points, transport details, commitments, and availability still require authoritative state. These procedures never grant permission to send, book, charge, refund, promise, or bypass an approval gate.\n\n${active.map((r) => {
    const conditions = [r.trigger.when, ...(r.trigger.conditions ?? [])].filter(Boolean).join('; ')
    const actions = [...(r.behavior.do ?? []).map((x) => `do: ${x}`), ...(r.behavior.avoid ?? []).map((x) => `avoid: ${x}`)].join('; ')
    const provenance = r.source_excerpt ? ` Learned from the operator correction: “${r.source_excerpt}”.` : ''
    const prior = r.supersedes?.length ? ` This replaced earlier operator guidance: ${r.supersedes.map((x) => `“${x.source_excerpt}”`).join('; ')}.` : ''
    return `- ${r.knowledge_type.replace('_', ' ')}. When: ${conditions}. Behavior: ${actions}. Why: ${r.rationale ?? 'operator guidance'}.${provenance}${prior}`
  }).join('\n')}`
}

export function explainLearnedKnowledge(row: LearnedOperatingKnowledge): string {
  const state = row.status === 'superseded' ? 'superseded' : row.status
  const source = row.source_excerpt ? ` It came from the operator correction: “${row.source_excerpt}”.` : ''
  const replacement = row.superseded_by ? ` It was replaced by newer guidance (${row.superseded_by}).` : ''
  return `${row.rationale ?? 'This is workspace operating guidance.'} Status: ${state}.${source}${replacement}`
}

export async function fetchLearnedOperatingKnowledge(workspaceId: string): Promise<LearnedOperatingKnowledge[]> {
  try {
    const supabase = createServiceClient()
    const { data, error } = await supabase.from('learned_operating_knowledge')
      .select('id,knowledge_type,status,scope,trigger,behavior,rationale,source_excerpt,promotion_reason,superseded_by')
      .eq('workspace_id', workspaceId).eq('status', 'active').is('superseded_at', null)
      .order('updated_at', { ascending: false }).limit(100)
    if (error) { console.error('[operator-learning] retrieval failed:', error.message); return [] }
    const rows = (data ?? []) as LearnedOperatingKnowledge[]
    if (rows.length) {
      const { data: prior } = await supabase.from('learned_operating_knowledge')
        .select('id,source_excerpt,superseded_by').eq('workspace_id', workspaceId)
        .eq('status', 'superseded').in('superseded_by', rows.map((r) => r.id))
      for (const row of rows) row.supersedes = ((prior ?? []) as Array<{id:string;source_excerpt:string;superseded_by:string}>)
        .filter((p) => p.superseded_by === row.id).map(({ id, source_excerpt }) => ({ id, source_excerpt }))
    }
    if (rows.length) void supabase.from('learned_operating_knowledge_audit').insert(rows.flatMap((r) => ([
      { workspace_id: workspaceId, knowledge_id: r.id, event_type: 'retrieved', details: { surface: 'agent_context' } },
      // "Applied" here means deterministically injected into the current
      // model context, not that a send/action occurred. Execution evidence
      // remains exclusively in the existing action ledgers and gates.
      { workspace_id: workspaceId, knowledge_id: r.id, event_type: 'applied', details: { stage: 'agent_context_injection' } },
    ])))
    return rows
  } catch (err) {
    console.warn('[operator-learning] retrieval unavailable:', err)
    return []
  }
}

async function deriveCandidate(workspaceId: string, operatorText: string, previousCayeText: string | null): Promise<CorrectionCandidate | null> {
  if (obviousOneOffInstruction(operatorText)) return null
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const response = await loggedMessagesCreate(client, {
    model: 'claude-sonnet-4-6', max_tokens: 700,
    system: `Classify an authorized operator message as reusable operating knowledge. Return JSON only. Do not copy raw prose: abstract a structured rule. A correction to one draft can be reusable but is not automatically durable. Separate procedure (how), operator_preference (presentation/tone), constraint (must/must-not), and business_fact (objective durable truth). Mark one_off for person/booking-specific changes. Mark consequential for rules involving prices, payments, refunds, bookings, commitments, sends, permissions, legal/safety, or external parties. Never turn missing booking facts into reusable facts. canonical_key must be a short stable semantic key derived from type+scope+trigger, not names or wording. Shape: {"learnable":boolean,"reusable":boolean,"knowledge_type":"business_fact|procedure|operator_preference|constraint","scope":{},"trigger":{"when":"","conditions":[]},"behavior":{"do":[],"avoid":[],"requires_authoritative_state":[]},"rationale":"","canonical_key":"","confidence":0.0,"risk_level":"low|consequential","one_off":boolean}`,
    messages: [{ role: 'user', content: `Caye's preceding message:\n${previousCayeText ?? '(none)'}\n\nOperator message:\n${operatorText}` }],
  }, { source: 'lib/operator-learning.ts:deriveCandidate', workspaceId })
  const raw = response.content[0]?.type === 'text' ? response.content[0].text : ''
  const p = JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')) as Record<string, unknown>
  if (!p.learnable || !p.reusable || p.one_off) return null
  return {
    learnable: true, reusable: true, knowledgeType: p.knowledge_type as LearnedKnowledgeType,
    scope: (p.scope ?? {}) as Record<string, unknown>, trigger: p.trigger as CorrectionCandidate['trigger'],
    behavior: p.behavior as CorrectionCandidate['behavior'], rationale: String(p.rationale ?? ''),
    canonicalKey: String(p.canonical_key ?? '').slice(0, 160), confidence: Math.max(0, Math.min(1, Number(p.confidence) || 0)),
    riskLevel: p.risk_level === 'consequential' ? 'consequential' : 'low',
    explicitDurable: hasExplicitDurableScope(operatorText), oneOff: false,
  }
}

export async function learnFromAuthorizedOperatorCorrection(input: {
  workspaceId: string; operatorId: number | null; operatorRole: string; operatorText: string;
  previousCayeText: string | null; sourceMessageId: string | null; sourceConversationId?: string | null
}): Promise<void> {
  if (!input.operatorId || !['owner','staff','founder'].includes(input.operatorRole)) return
  if (!plausiblyReusableCorrection(input.operatorText, input.previousCayeText)) return
  let candidate: CorrectionCandidate | null
  try { candidate = await deriveCandidate(input.workspaceId, input.operatorText, input.previousCayeText) }
  catch (err) { console.warn('[operator-learning] classification failed:', err); return }
  if (!candidate || !candidate.canonicalKey) return
  const { status, reason } = decideInitialStatus(candidate)
  const supabase = createServiceClient()
  await supabase.from('learned_operating_knowledge_audit').insert({ workspace_id: input.workspaceId,
    event_type: 'correction_detected', source_operator_id: input.operatorId, source_message_id: input.sourceMessageId,
    source_conversation_id: input.sourceConversationId ?? null, details: { knowledge_type: candidate.knowledgeType, canonical_key: candidate.canonicalKey } })
  const { data: active } = await supabase.from('learned_operating_knowledge').select('id,behavior,rationale')
    .eq('workspace_id', input.workspaceId).eq('canonical_key', candidate.canonicalKey).eq('status','active').is('superseded_at',null).maybeSingle()
  // Same canonical scope with materially different structured behavior is a
  // focused conflict. An explicit operator correction cleanly supersedes;
  // otherwise preserve uncertainty as a candidate.
  const differs = !!active && JSON.stringify(active.behavior) !== JSON.stringify(candidate.behavior)
  if (active && !differs) {
    await supabase.from('learned_operating_knowledge_audit').insert({ workspace_id: input.workspaceId,
      knowledge_id: active.id, event_type: 'applied', source_operator_id: input.operatorId,
      source_message_id: input.sourceMessageId, source_conversation_id: input.sourceConversationId ?? null,
      details: { reason: 'matching_authorized_correction_reinforced_active_guidance' } })
    return
  }
  const canSupersede = differs && candidate.explicitDurable && candidate.riskLevel === 'low' && candidate.knowledgeType !== 'business_fact'
  const finalStatus = differs && !canSupersede ? 'candidate' : status
  const { data, error } = await supabase.rpc('record_operator_learning', {
    p_workspace_id: input.workspaceId, p_knowledge_type: candidate.knowledgeType, p_status: finalStatus,
    p_scope: candidate.scope, p_trigger: candidate.trigger, p_behavior: candidate.behavior,
    p_rationale: candidate.rationale, p_canonical_key: candidate.canonicalKey, p_confidence: candidate.confidence,
    p_risk_level: candidate.riskLevel, p_source_operator_id: input.operatorId, p_source_message_id: input.sourceMessageId,
    p_source_conversation_id: input.sourceConversationId ?? null, p_source_excerpt: input.operatorText.slice(0,500),
    p_promotion_reason: differs && !canSupersede ? 'ambiguous_conflict_requires_clarification' : reason,
    p_supersede_id: canSupersede ? active.id : null,
  })
  if (error) { console.error('[operator-learning] persistence failed:', error.message); return }
  const row = Array.isArray(data) ? data[0] : data
  await supabase.from('learned_operating_knowledge_audit').insert({ workspace_id: input.workspaceId,
    knowledge_id: row?.id ?? null, event_type: finalStatus === 'active' ? 'promoted' : (differs ? 'conflict' : 'candidate_created'),
    source_operator_id: input.operatorId, source_message_id: input.sourceMessageId,
    source_conversation_id: input.sourceConversationId ?? null, details: { reason, canonical_key: candidate.canonicalKey } })
  if (canSupersede) await supabase.from('learned_operating_knowledge_audit').insert({ workspace_id: input.workspaceId,
    knowledge_id: active.id, event_type: 'superseded', source_operator_id: input.operatorId,
    source_message_id: input.sourceMessageId, source_conversation_id: input.sourceConversationId ?? null,
    details: { superseded_by: row?.id ?? null, reason: 'newer_explicit_authorized_correction' } })
}
