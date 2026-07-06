import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { fetchBusinessFacts } from '@/lib/business-facts'
import { sendFreeFormWhatsApp } from '@/lib/whatsapp/outbound'
import { operatorPingsEnabled } from '@/lib/whatsapp/triggers'
import {
  extractCandidateSentences,
  normalizeSentence,
  guessCategory,
  shouldProposeCandidate,
  OCCURRENCE_THRESHOLD,
} from '@/lib/business-fact-candidate-detection'

/**
 * Fire-and-forget hook called after the owner sends a manual reply
 * (same call sites as maybeRefreshOwnerVoiceProfile). Watches for stable
 * business knowledge — pickup points, contact info, cancellation policy —
 * that the owner keeps retyping by hand across separate conversations
 * instead of teaching Caye once via add_business_fact.
 *
 * Confirmed live (Bridgette Jones / Bimini, 2026-07-04/05): this exact
 * content had been retyped across 15+ conversations since 2026-04-27
 * with zero uses of add_business_fact — passive tool availability wasn't
 * enough, so this proactively surfaces the pattern after
 * OCCURRENCE_THRESHOLD repeats.
 *
 * Safe to .catch() at the caller — non-critical to reply correctness.
 */
export async function maybeSuggestBusinessFacts(
  workspaceId: string,
  conversationId: string,
  content: string
): Promise<void> {
  const sentences = extractCandidateSentences(content)
  if (sentences.length === 0) return

  const supabase = createServiceClient()

  for (const sentence of sentences) {
    const normalized = normalizeSentence(sentence)
    if (!normalized) continue

    const { data: existing, error: readErr } = await supabase
      .from('business_fact_candidates')
      .select('id, status, occurrence_count, conversation_ids')
      .eq('workspace_id', workspaceId)
      .eq('normalized_text', normalized)
      .maybeSingle()

    if (readErr) {
      console.warn('[business-fact-suggestions] read failed:', readErr.message)
      continue
    }

    if (!existing) {
      const { error: insertErr } = await supabase.from('business_fact_candidates').insert({
        workspace_id: workspaceId,
        normalized_text: normalized,
        sample_text: sentence,
        category_guess: guessCategory(sentence),
        conversation_ids: [conversationId],
        occurrence_count: 1,
      })
      if (insertErr) console.warn('[business-fact-suggestions] insert failed:', insertErr.message)
      continue
    }

    const conversationIds: string[] = Array.isArray(existing.conversation_ids)
      ? existing.conversation_ids
      : []
    const isNewConversation = !conversationIds.includes(conversationId)
    const newCount = isNewConversation ? existing.occurrence_count + 1 : existing.occurrence_count

    const { error: updateErr } = await supabase
      .from('business_fact_candidates')
      .update({
        sample_text: sentence,
        occurrence_count: newCount,
        conversation_ids: isNewConversation ? [...conversationIds, conversationId] : conversationIds,
        last_seen_at: new Date().toISOString(),
      })
      .eq('id', existing.id)

    if (updateErr) {
      console.warn('[business-fact-suggestions] update failed:', updateErr.message)
      continue
    }

    if (!shouldProposeCandidate(existing.status, newCount)) continue

    const alreadyKnown = await overlapsExistingFact(workspaceId, normalized)
    if (alreadyKnown) {
      await supabase
        .from('business_fact_candidates')
        .update({ status: 'resolved' })
        .eq('id', existing.id)
      continue
    }

    await proposeCandidate(supabase, workspaceId, existing.id, sentence, guessCategory(sentence))
  }
}

/** Cheap word-overlap check against facts already saved for this workspace. */
async function overlapsExistingFact(workspaceId: string, normalized: string): Promise<boolean> {
  const facts = await fetchBusinessFacts(workspaceId)
  if (facts.length === 0) return false
  const candidateWords = new Set(normalized.split(' ').filter(w => w.length > 3))
  if (candidateWords.size === 0) return false
  return facts.some(f => {
    const factWords = normalizeSentence(f.fact).split(' ').filter(w => w.length > 3)
    if (factWords.length === 0) return false
    const overlap = factWords.filter(w => candidateWords.has(w)).length
    return overlap / factWords.length >= 0.6
  })
}

async function proposeCandidate(
  supabase: ReturnType<typeof createServiceClient>,
  workspaceId: string,
  candidateId: string,
  sampleText: string,
  category: string
): Promise<void> {
  await supabase
    .from('business_fact_candidates')
    .update({ status: 'proposed', proposed_at: new Date().toISOString() })
    .eq('id', candidateId)

  const proposalText =
    `Hey — I've noticed you telling guests the same thing in ${OCCURRENCE_THRESHOLD} different conversations:\n\n` +
    `"${sampleText}"\n\n` +
    `Want me to save this as a standing fact (${category.replace('_', ' ')}) so I say it myself next time? ` +
    `Just say yes and I'll remember it.`

  // Write into the back-office conversation history so the next turn's
  // sliding window (loadOperatorContext) includes this proposal — if the
  // owner replies "yes", Caye already has the fact text in context and can
  // call add_business_fact herself. operator_allowlist_id stays null so it
  // surfaces to whichever operator opens the back-office thread next.
  await supabase.from('caye_operator_messages').insert({
    workspace_id: workspaceId,
    direction: 'outbound',
    wa_message_id: null,
    body: proposalText,
    intent: 'fact_suggestion',
    claude_format: { role: 'assistant', content: proposalText },
    operator_allowlist_id: null,
    operator_name: null,
    operator_role: null,
  })

  // Best-effort live nudge. If the 24h free-form window is closed or the
  // workspace hasn't verified operator WhatsApp, the proposal still sits in
  // caye_operator_messages and surfaces next time the owner opens the thread
  // — same "conservative and visible" fallback used elsewhere in Caye.
  try {
    if (!(await operatorPingsEnabled(workspaceId))) return
    const { data: cfg } = await supabase
      .from('workspace_ai_config')
      .select('operator_whatsapp_number, operator_notification_override_phone')
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    const phone = cfg?.operator_notification_override_phone ?? cfg?.operator_whatsapp_number
    if (!phone) return
    await sendFreeFormWhatsApp(phone, proposalText, `fact-suggestion-${candidateId}`)
  } catch (err) {
    console.warn('[business-fact-suggestions] ping send failed:', err)
  }
}
