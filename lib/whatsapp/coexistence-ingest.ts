import 'server-only'
import type { createServiceClient } from '@/lib/supabase-server'
import type { ObservedWhatsAppMessage, WhatsAppMessageOrigin } from './coexistence'
import { isAutoReplyEligible } from './coexistence'
import { mediaPlaceholder } from '@/lib/operator-text-guard'
import { resolveOrCreateContact } from '@/lib/contacts/resolve-contact'

/**
 * Observe-only persistence for WhatsApp activity Caye did not author.
 *
 * This module never sends anything. It has no import path to
 * generateCayeAutoReply, sendWhatsAppMessage, or any dispatch helper, which
 * is the point: the guarantee that observing the owner's WhatsApp Business
 * app cannot produce a reply is structural, not a conditional someone can
 * later invert by accident.
 *
 * HOW HUMAN ACTIVITY BECOMES DURABLE UNDERSTANDING — WITHOUT BECOMING TRUTH
 * Nothing new was invented for this. A `unified_messages` insert already
 * fans out through two applied triggers:
 *
 *   trg_caye_event_unified_message      → workspace_events, with actor_kind
 *     derived from metadata.authored_by ('human' → 'operator', absent →
 *     'unknown'). That is the audit/provenance record.
 *   trg_enqueue_unified_message_for_business_learning →
 *     business_learning_observations, whose downstream candidates land in
 *     business_fact_candidates with customer_use_state
 *     'requires_confirmation'.
 *
 * So a claim the owner types into WhatsApp ("the slab is finished") becomes
 * an observation with a named human author and a confirmation requirement — evidence, never a
 * silently-promoted project milestone. Writing metadata.authored_by honestly
 * is the entire mechanism; there is no coexistence-specific fact path, and
 * deliberately no customer-specific parsing anywhere in this file.
 *
 * metadata.sent_by='human' matches the flag the Zoho-sent owner path already
 * writes (app/api/email/poll/route.ts), so existing readers —
 * hasRecentManualOutboundEvidence, isManualOwnerMessage — recognise a reply
 * the owner typed on their phone without a single change to those modules.
 */

/**
 * The client is passed in rather than constructed here, matching
 * lib/whatsapp/actions/handled.ts: the webhook already holds one, and tests
 * supply a fake without mocking the module graph.
 */
type Supabase = ReturnType<typeof createServiceClient>

export interface CoexistenceAccount {
  /** connected_accounts.id */
  id: string
  /** connected_accounts.user_id — the workspace. */
  workspaceId: string
}

export type CoexistenceOutcome =
  | 'observed'
  | 'duplicate'
  | 'caye_authored_skipped'
  | 'amended'
  | 'unresolved_reference'
  | 'conversation_unavailable'
  | 'error'

export interface CoexistenceIngestResult {
  outcome: CoexistenceOutcome
  origin: WhatsAppMessageOrigin
  conversationId: string | null
  /** Always false. Asserted in tests as the anti-loop invariant. */
  autoReplyEligible: false
}

/**
 * Whether this provider message id belongs to a send Caye already recorded.
 *
 * Two shapes are accepted because two eras of send code exist: newer rows
 * carry Meta's real wamid at metadata.wa_message_id, and any row whose
 * channel_message_id IS the wamid matches directly. A synthetic id
 * (`caye_wa_…`, `op-wa-…`) matches neither, which is the honest answer — see
 * the reconciliation note in lib/whatsapp/coexistence.ts.
 */
export async function echoMatchesRecordedCayeSend(
  supabase: Supabase,
  providerMessageId: string
): Promise<boolean> {
  const [byChannelId, byMetadata] = await Promise.all([
    supabase.from('unified_messages').select('id').eq('channel_message_id', providerMessageId).maybeSingle(),
    supabase.from('unified_messages').select('id').contains('metadata', { wa_message_id: providerMessageId }).maybeSingle(),
  ])
  if (byChannelId?.error) console.error('[whatsapp coexistence] echo reconciliation (channel id) failed:', byChannelId.error)
  if (byMetadata?.error) console.error('[whatsapp coexistence] echo reconciliation (metadata) failed:', byMetadata.error)
  return Boolean(byChannelId?.data || byMetadata?.data)
}

/**
 * Finds the canonical conversation for a WhatsApp thread, creating it only
 * when none exists.
 *
 * Deliberately not an upsert. An upsert would have to restate
 * customer_name, and an echo does not carry one — Meta's echo payload names
 * only phone numbers. Overwriting a real contact name with a phone number
 * because the owner happened to reply from their phone would corrupt the
 * inbox for the sake of a write convenience.
 */
async function findOrCreateConversation(
  supabase: Supabase,
  account: CoexistenceAccount,
  observed: ObservedWhatsAppMessage
): Promise<{ id: string; contact_id: string | null } | null> {
  const { data: existing, error: findErr } = await supabase
    .from('unified_conversations')
    .select('id, contact_id')
    .eq('connected_account_id', account.id)
    .eq('channel_conversation_id', observed.counterpartyWaId)
    .maybeSingle()

  if (findErr) {
    console.error('[whatsapp coexistence] conversation lookup failed:', findErr)
    return null
  }
  if (existing) return existing

  const contactRow = await resolveOrCreateContact(supabase, {
    workspaceId: account.workspaceId,
    channelType: 'whatsapp',
    channelId: observed.counterpartyWaId,
    // No display name exists in an echo payload. The wa_id is the honest
    // placeholder; the customer's own next inbound message supplies the real
    // profile name through the ordinary path.
    name: observed.counterpartyWaId,
    at: observed.observedAt,
  })

  const { data: created, error: insertErr } = await supabase
    .from('unified_conversations')
    .insert({
      connected_account_id: account.id,
      channel_type: 'whatsapp',
      channel_conversation_id: observed.counterpartyWaId,
      customer_name: observed.counterpartyWaId,
      customer_id: observed.counterpartyWaId,
      contact_id: contactRow?.id,
      status: 'open',
      metadata: {
        wa_id: observed.counterpartyWaId,
        phone_number_id: observed.provenance.phone_number_id,
        // The thread was first seen because the business wrote on it, not
        // because a customer did. Worth recording: it changes how an
        // "unanswered" report should read this row.
        first_seen_via: observed.provenance.webhook_field,
      },
    })
    .select('id, contact_id')
    .single()

  if (insertErr || !created) {
    console.error('[whatsapp coexistence] conversation create failed:', insertErr)
    return null
  }
  return created
}

function observationContent(observed: ObservedWhatsAppMessage): string {
  if (observed.isText) return observed.text ?? ''
  return mediaPlaceholder(observed.messageType)
}

/**
 * Provenance written onto every observed row.
 *
 * `authored_by` is included ONLY for business_app_operator, where a human
 * demonstrably composed the text. For unknown_business_origin it is omitted
 * on purpose, so the workspace_events trigger records actor_kind='unknown'
 * rather than an authorship nobody established.
 */
function observationMetadata(
  observed: ObservedWhatsAppMessage,
  origin: WhatsAppMessageOrigin
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    source: origin === 'business_app_operator' ? 'whatsapp_business_app' : 'whatsapp_business_number',
    origin_classification: origin,
    observed_via: observed.provenance.webhook_field,
    provider_type: observed.provenance.provider_type,
    wa_message_id: observed.providerMessageId,
    phone_number_id: observed.provenance.phone_number_id,
    display_phone_number: observed.provenance.display_phone_number,
    // Caye watched this happen; she did not do it. Distinguishes an
    // observation from an action for anything auditing what Caye performed.
    is_observation: true,
  }
  if (origin === 'business_app_operator') {
    base.authored_by = 'human'
    base.sent_by = 'human'
  } else {
    base.authorship = 'unresolved'
  }
  return base
}

/**
 * Persists one observed business-side message.
 *
 * Idempotent on `channel_message_id`: Meta retries webhook deliveries, and a
 * redelivered echo must not become a second row, a second learning
 * observation, or a second workspace event.
 */
export async function ingestObservedBusinessMessage(
  supabase: Supabase,
  account: CoexistenceAccount,
  observed: ObservedWhatsAppMessage,
  origin: WhatsAppMessageOrigin
): Promise<CoexistenceIngestResult> {
  const result = (outcome: CoexistenceOutcome, conversationId: string | null = null): CoexistenceIngestResult => ({
    outcome,
    origin,
    conversationId,
    autoReplyEligible: false,
  })

  // Belt and braces. Nothing in this module can reply, but an origin that
  // IS auto-reply eligible reaching the observe-only path means a caller
  // routed a customer message here — a bug worth refusing loudly rather
  // than half-persisting.
  if (isAutoReplyEligible(origin)) {
    console.error('[whatsapp coexistence] refusing to observe an external_contact message on the observe-only path')
    return result('error')
  }

  if (origin === 'caye_cloud_api') return result('caye_authored_skipped')

  const conversation = await findOrCreateConversation(supabase, account, observed)
  if (!conversation) return result('conversation_unavailable')

  if (observed.observationKind !== 'message') {
    return amendReferencedMessage(supabase, conversation.id, observed, origin)
  }

  const { data: existing, error: dedupeErr } = await supabase
    .from('unified_messages')
    .select('id')
    .eq('channel_message_id', observed.providerMessageId)
    .maybeSingle()
  if (dedupeErr) {
    console.error('[whatsapp coexistence] dedupe lookup failed:', dedupeErr)
    return result('error', conversation.id)
  }
  if (existing) return result('duplicate', conversation.id)

  const content = observationContent(observed)
  const { error: insertErr } = await supabase.from('unified_messages').insert({
    conversation_id: conversation.id,
    channel_message_id: observed.providerMessageId,
    sender_type: 'business',
    content,
    message_type: observed.isText ? 'text' : observed.messageType,
    sent_at: observed.observedAt,
    status: 'sent',
    is_internal: false,
    metadata: observationMetadata(observed, origin),
  })
  if (insertErr) {
    console.error('[whatsapp coexistence] observation insert failed:', insertErr)
    return result('error', conversation.id)
  }

  // Conversation sender state is only advanced when authorship is known.
  // With unknown_business_origin we have a message and no author; writing
  // last_business_sender_kind would be a guess, and readers such as the
  // stale-hold sweep treat that field as fact.
  if (origin === 'business_app_operator') {
    const { error: convErr } = await supabase
      .from('unified_conversations')
      .update({
        last_message_at: observed.observedAt,
        last_message_preview: content.slice(0, 100),
        last_sender_type: 'business',
        last_business_sender_kind: 'human',
      })
      .eq('id', conversation.id)
    if (convErr) console.error('[whatsapp coexistence] conversation state update failed:', convErr)
  }

  return result('observed', conversation.id)
}

/**
 * Applies an `edit` or `revoke` echo to the row it references.
 *
 * Non-destructive by construction: an edit appends to metadata.edits with the
 * superseded text kept at `superseded_content`, and a revoke marks
 * metadata.revoked_at instead of deleting anything. When the referenced message was never ingested (it
 * predates coexistence onboarding, or arrived while the webhook was down)
 * the event is reported unresolved and dropped — inventing the row it
 * amends would be worse than the gap.
 */
async function amendReferencedMessage(
  supabase: Supabase,
  conversationId: string,
  observed: ObservedWhatsAppMessage,
  origin: WhatsAppMessageOrigin
): Promise<CoexistenceIngestResult> {
  const result = (outcome: CoexistenceOutcome): CoexistenceIngestResult => ({
    outcome,
    origin,
    conversationId,
    autoReplyEligible: false,
  })

  const referenced = observed.referencedMessageId
  if (!referenced) return result('unresolved_reference')

  const { data: target, error: findErr } = await supabase
    .from('unified_messages')
    .select('id, content, metadata')
    .eq('channel_message_id', referenced)
    .maybeSingle()
  if (findErr) {
    console.error('[whatsapp coexistence] amendment lookup failed:', findErr)
    return result('error')
  }
  if (!target) return result('unresolved_reference')

  const priorMetadata = (target.metadata ?? {}) as Record<string, unknown>

  if (observed.observationKind === 'revoke') {
    if (priorMetadata.revoked_at) return result('duplicate')
    const { error } = await supabase
      .from('unified_messages')
      .update({
        metadata: {
          ...priorMetadata,
          revoked_at: observed.observedAt,
          revoked_by_provider_message_id: observed.providerMessageId,
        },
      })
      .eq('id', target.id)
    if (error) {
      console.error('[whatsapp coexistence] revoke amendment failed:', error)
      return result('error')
    }
    return result('amended')
  }

  const edits = Array.isArray(priorMetadata.edits) ? (priorMetadata.edits as unknown[]) : []
  if (edits.some((e) => (e as Record<string, unknown>)?.provider_message_id === observed.providerMessageId)) {
    return result('duplicate')
  }

  const { error } = await supabase
    .from('unified_messages')
    .update({
      content: observationContent(observed),
      message_type: observed.isText ? 'text' : observed.messageType,
      metadata: {
        ...priorMetadata,
        edits: [
          ...edits,
          {
            provider_message_id: observed.providerMessageId,
            edited_at: observed.observedAt,
            superseded_content: target.content ?? null,
          },
        ],
      },
    })
    .eq('id', target.id)
  if (error) {
    console.error('[whatsapp coexistence] edit amendment failed:', error)
    return result('error')
  }
  return result('amended')
}

/**
 * Audit trail for a `messages` entry sent from the business's own number.
 *
 * This shape is not documented by Meta and, unlike an echo, carries no `to`
 * field — so there is no way to say which thread it belongs to. Creating a
 * conversation keyed on the business's own number to hold it would be a
 * fabricated thread, so nothing is written to unified_conversations or
 * unified_messages. What IS recorded is that an unattributable business-side
 * message was observed, at actor_kind 'unknown', so the gap is visible to
 * anyone auditing rather than being a silent `continue` as it was before.
 */
export async function recordUnattributedBusinessMessage(
  supabase: Supabase,
  args: {
    workspaceId: string
    providerMessageId: string
    observedAt: string
    messageType: string
    phoneNumberId: string
    preview: string | null
  }
): Promise<void> {
  // Meta redelivers on any non-200, so the audit trail needs its own dedupe:
  // workspace_events has no natural key for an app-origin row, and a repeated
  // delivery must not read as the message having happened twice.
  const { data: already, error: lookupErr } = await supabase
    .from('workspace_events')
    .select('id')
    .eq('workspace_id', args.workspaceId)
    .eq('type', 'message.unattributed_business_origin')
    .contains('payload', { wa_message_id: args.providerMessageId })
    .maybeSingle()
  if (lookupErr) {
    console.error('[whatsapp coexistence] unattributed-origin dedupe lookup failed:', lookupErr)
    return
  }
  if (already) return

  const { error } = await supabase.from('workspace_events').insert({
    workspace_id: args.workspaceId,
    occurred_at: args.observedAt,
    type: 'message.unattributed_business_origin',
    actor_kind: 'unknown',
    is_failure: false,
    subject_table: 'connected_accounts',
    subject_id: args.phoneNumberId,
    payload: {
      source: 'whatsapp_webhook',
      origin_classification: 'unknown_business_origin',
      observed_via: 'messages',
      wa_message_id: args.providerMessageId,
      message_type: args.messageType,
      preview: args.preview ? args.preview.slice(0, 200) : null,
    },
    origin: 'app',
  })
  if (error) console.error('[whatsapp coexistence] unattributed-origin audit failed:', error)
}
