import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { fetchBusinessFacts } from '@/lib/business-facts'
import { sendFreeFormWhatsApp, deliveryFieldsFromResult } from '@/lib/whatsapp/outbound'
import { operatorPingsEnabled } from '@/lib/whatsapp/triggers'
import { findSemanticFactMatch } from '@/lib/business-fact-semantic-match'
import {
  extractCandidateSentences,
  normalizeSentence,
  guessCategory,
  shouldProposeCandidate,
  OCCURRENCE_THRESHOLD,
} from '@/lib/business-fact-candidate-detection'

const SEMANTIC_MATCH_SOURCE = 'lib/business-fact-suggestions.ts:maybeSuggestBusinessFacts'

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

    // Exact match first — free, and still the common case for a sentence copy-pasted
    // from a saved template. Falls back to semantic matching only on a miss, so most
    // sentences never cost an LLM call.
    const { data: exact, error: readErr } = await supabase
      .from('business_fact_candidates')
      .select('id, status, occurrence_count, conversation_ids')
      .eq('workspace_id', workspaceId)
      .eq('normalized_text', normalized)
      .maybeSingle()

    if (readErr) {
      console.warn('[business-fact-suggestions] read failed:', readErr.message)
      continue
    }

    let existing = exact
    if (!existing) {
      // No exact match — check whether this is the same fact as an already-open
      // candidate, just worded differently. This is the fix for the confirmed
      // 2026-08-07 bug: Bimini's tram-stop meeting point was retyped two different
      // ways and filed as two permanently-unmerged rows because the old path only
      // ever checked normalized_text equality. See briefs/cold-start-plan.md.
      const { data: pending } = await supabase
        .from('business_fact_candidates')
        .select('id, status, occurrence_count, conversation_ids, sample_text')
        .eq('workspace_id', workspaceId)
        .in('status', ['pending', 'proposed'])
      const openCandidates = (pending ?? []) as Array<{
        id: string
        status: 'pending' | 'proposed' | 'resolved' | 'dismissed'
        occurrence_count: number
        conversation_ids: unknown
        sample_text: string
      }>

      if (openCandidates.length > 0) {
        const { matchId } = await findSemanticFactMatch(
          sentence,
          openCandidates.map((c) => ({ id: c.id, text: c.sample_text })),
          { workspaceId, source: SEMANTIC_MATCH_SOURCE }
        )
        if (matchId) existing = openCandidates.find((c) => c.id === matchId) ?? null
      }
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

    const alreadyKnown = await overlapsExistingFact(workspaceId, sentence)
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

/**
 * Is this candidate already covered by a saved fact? Was a crude 60% word-overlap
 * heuristic — replaced 2026-08-07 with the same semantic-match primitive used for
 * candidate-to-candidate merging, for the same reason: word overlap is a poor proxy
 * for "same fact" (it both misses paraphrases and false-positives on topically
 * related but factually different sentences — "refunds take 30 days" vs "refunds
 * require investigation" share enough words to clear 60% while meaning opposite
 * things).
 */
async function overlapsExistingFact(workspaceId: string, sentence: string): Promise<boolean> {
  const facts = await fetchBusinessFacts(workspaceId)
  if (facts.length === 0) return false
  const { matchId } = await findSemanticFactMatch(
    sentence,
    facts.map((f) => ({ id: f.id, text: f.fact })),
    { workspaceId, source: SEMANTIC_MATCH_SOURCE }
  )
  return matchId !== null
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

  // candidate_id is embedded so a later turn can call confirm_fact_candidate /
  // dismiss_fact_candidate with the right id straight from context — see
  // lib/caye-agent/modes/back-office.ts for the instruction telling Caye to use
  // those tools (not add_business_fact) when she sees this shape of message.
  const proposalText =
    `Hey — I've noticed you telling guests the same thing in ${OCCURRENCE_THRESHOLD} different conversations:\n\n` +
    `"${sampleText}"\n\n` +
    `Want me to save this as a standing fact (${category.replace('_', ' ')}) so I say it myself next time? ` +
    `Just say yes and I'll remember it.\n\n` +
    `[candidate_id: ${candidateId}]`

  // Write into the back-office conversation history so the next turn's
  // sliding window (loadOperatorContext) includes this proposal — if the
  // owner replies "yes", Caye already has the fact text in context and can
  // call add_business_fact herself. operator_allowlist_id stays null so it
  // surfaces to whichever operator opens the back-office thread next.
  //
  // Inserted before the WhatsApp nudge below (which is best-effort and
  // conditional) rather than after, so the proposal is visible in Caye
  // Direct even when no ping fires at all — the row's delivery fields are
  // filled in afterward, by id, only if a send actually happens.
  const { data: inserted } = await supabase
    .from('caye_operator_messages')
    .insert({
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
    .select('id')
    .single()

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
    const result = await sendFreeFormWhatsApp(phone, proposalText, `fact-suggestion-${candidateId}`)
    if (inserted) {
      await supabase
        .from('caye_operator_messages')
        .update(deliveryFieldsFromResult(result))
        .eq('id', inserted.id)
    }
  } catch (err) {
    console.warn('[business-fact-suggestions] ping send failed:', err)
  }
}
