import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { normalizeSentence, guessCategory } from '@/lib/business-fact-candidate-detection'
import { sendFreeFormWhatsApp, deliveryFieldsFromResult } from '@/lib/whatsapp/outbound'
import { operatorPingsEnabled } from '@/lib/whatsapp/triggers'
import type { ClassificationResult, Destination } from './schema'

/**
 * operator-learning/hold.ts
 *
 * Surfaces a classification the router decided NOT to write live
 * (consequential / ambiguous / staff-authored / low-confidence) to the
 * owner, so it's actionable rather than silently sitting in an audit table
 * only an engineer would ever read.
 *
 * For destination === 'business_fact': reuses the EXISTING
 * business_fact_candidates → confirm_fact_candidate/dismiss_fact_candidate
 * loop, so the owner's "yes" in back-office chat closes it exactly the way
 * a passively-detected candidate already does — one funnel, two producers.
 *
 * For every other destination: no new candidate table (the task is explicit
 * that this must not become a second authoritative store). The proposal is
 * surfaced the same way business-fact-suggestions.ts already does — a
 * message written into caye_operator_messages (so it's in the back-office
 * sliding window on the next turn) plus a best-effort WhatsApp nudge — but
 * with no confirm/dismiss TOOL wired to it in this PR. An operator who wants
 * it applied says so in back-office chat and Caye uses the existing specific
 * tool (update_service_price, add_team_member, ...) normally. This keeps the
 * surface area additive: visibility now, a dedicated confirm path is a
 * natural fast-follow once real hold volume is observed.
 */

export async function holdBusinessFactCandidate(args: {
  workspaceId: string
  conversationId: string | null
  classification: ClassificationResult
}): Promise<{ candidateId: string | null }> {
  const text = args.classification.businessFact?.text
  if (!text) return { candidateId: null }
  const supabase = createServiceClient()
  const normalized = normalizeSentence(text)

  const { data: existing } = await supabase
    .from('business_fact_candidates')
    .select('id, occurrence_count, conversation_ids, status')
    .eq('workspace_id', args.workspaceId)
    .eq('normalized_text', normalized)
    .maybeSingle()

  if (existing) {
    if (existing.status === 'resolved' || existing.status === 'dismissed') return { candidateId: existing.id }
    return { candidateId: existing.id }
  }

  const { data: inserted, error } = await supabase
    .from('business_fact_candidates')
    .insert({
      workspace_id: args.workspaceId,
      normalized_text: normalized,
      sample_text: text,
      category_guess: args.classification.businessFact?.category ?? guessCategory(text),
      conversation_ids: args.conversationId ? [args.conversationId] : [],
      occurrence_count: 1,
      status: 'pending',
      source: 'live_repeat',
    })
    .select('id')
    .single()

  if (error) {
    console.error('[operator-learning-hold] business_fact_candidates insert failed:', error.message)
    return { candidateId: null }
  }
  return { candidateId: inserted?.id ?? null }
}

/**
 * Generic hold notice for non-business_fact destinations (pricing, contact,
 * availability). Writes into the back-office sliding window + best-effort
 * WhatsApp nudge, same mechanism business-fact-suggestions.ts uses.
 */
export async function holdGenericNotice(args: {
  workspaceId: string
  destination: Destination
  classification: ClassificationResult
  reason: string
}): Promise<void> {
  const supabase = createServiceClient()
  const summary = summarizeForOperator(args.destination, args.classification)
  const noticeText =
    `Hey — I heard this and want to make sure before I save it:\n\n` +
    `"${summarizeSourceStatement(args.classification)}"\n\n` +
    `${summary}\n\nWhy I held it: ${args.reason}.\n\n` +
    `If that's right, just tell me directly and I'll save it the normal way.`

  const { data: inserted } = await supabase
    .from('caye_operator_messages')
    .insert({
      workspace_id: args.workspaceId,
      direction: 'outbound',
      wa_message_id: null,
      body: noticeText,
      intent: 'learning_hold_notice',
      claude_format: { role: 'assistant', content: noticeText },
      operator_allowlist_id: null,
      operator_name: null,
      operator_role: null,
    })
    .select('id')
    .single()

  try {
    if (!(await operatorPingsEnabled(args.workspaceId))) return
    const { data: cfg } = await supabase
      .from('workspace_ai_config')
      .select('operator_whatsapp_number, operator_notification_override_phone')
      .eq('workspace_id', args.workspaceId)
      .maybeSingle()
    const phone = cfg?.operator_notification_override_phone ?? cfg?.operator_whatsapp_number
    if (!phone) return
    const result = await sendFreeFormWhatsApp(phone, noticeText, `learning-hold-${args.workspaceId}-${Date.now()}`)
    if (inserted) {
      await supabase.from('caye_operator_messages').update(deliveryFieldsFromResult(result)).eq('id', inserted.id)
    }
  } catch (err) {
    console.warn('[operator-learning-hold] nudge send failed:', err)
  }
}

function summarizeSourceStatement(c: ClassificationResult): string {
  return c.rationale || '(see audit log)'
}

function summarizeForOperator(destination: Destination, c: ClassificationResult): string {
  switch (destination) {
    case 'pricing':
      return c.pricing
        ? `Looks like a price update for "${c.pricing.serviceName}"${c.pricing.tierName ? ` (${c.pricing.tierName})` : ''}: $${c.pricing.priceAmount}${c.pricing.isFlat ? ' flat' : '/person'}.`
        : 'Looks like a pricing update.'
    case 'contact':
      return c.contact ? `Looks like a new contact: ${c.contact.name}, ${c.contact.phone}, role ${c.contact.role}.` : 'Looks like a new contact.'
    case 'availability_recurring':
      return c.availabilityRecurring
        ? `Looks like a standing availability rule for "${c.availabilityRecurring.serviceName}".`
        : 'Looks like a standing availability rule.'
    case 'availability_date':
      return c.availabilityDate
        ? `Looks like a one-date rule for "${c.availabilityDate.serviceName}" on ${c.availabilityDate.dateISO}.`
        : 'Looks like a one-date availability rule.'
    default:
      return 'Not sure exactly what to save yet.'
  }
}
