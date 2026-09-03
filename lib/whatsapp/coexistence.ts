/**
 * WhatsApp webhook normalization boundary.
 *
 * WHY THIS EXISTS
 * The customer webhook (app/api/webhooks/whatsapp/route.ts) used to read
 * `entry[0].changes[0].value` and infer everything about a message from its
 * `from` field: anything from the business's own number was dropped by a
 * self-loop guard. That guard is correct for preventing reply loops, but it
 * is the wrong shape for coexistence, where Meta delivers the owner's OWN
 * WhatsApp Business app messages to us on a DIFFERENT webhook field. Those
 * are real business activity Caye should observe — and must never answer.
 *
 * So origin is decided here, once, from the envelope Meta actually sends,
 * and downstream code branches on an explicit classification instead of
 * re-deriving one from a phone number.
 *
 * VERIFIED META CONTRACT (checked 2026-09-02)
 * Coexistence adds three webhook fields alongside the ordinary `messages`
 * field, per Meta's "Onboard WhatsApp Business app users" guide and the
 * `smb_message_echoes` webhook reference:
 *
 *   messages            — ordinary Cloud API inbound + delivery statuses
 *   smb_message_echoes  — messages the business sent from the WhatsApp
 *                         Business app or a linked companion device
 *   history             — past messages, only after the business approves
 *                         chat-history sharing during onboarding
 *   smb_app_state_sync  — the business's contacts, and later changes to them
 *
 * `smb_message_echoes` envelope (Meta reference):
 *   value.messaging_product = 'whatsapp'
 *   value.metadata          = { display_phone_number, phone_number_id }
 *   value.message_echoes[]  = { from, to, id, timestamp, type, [type]: {...} }
 *   type ∈ text | image | video | document | revoke | edit
 *   revoke: { original_message_id }
 *   edit:   { original_message_id, message: { type, [type]: {...} } }
 *
 * UNRESOLVED, DELIBERATELY NOT GUESSED
 * Meta documents echoes as reporting WhatsApp Business app / companion
 * device sends. It does NOT state whether a Cloud API send by Caye also
 * produces an echo. Rather than assume either way, `classifyEchoOrigin`
 * takes a reconciliation result: an echo whose provider message id matches
 * a send Caye already recorded is `caye_cloud_api`; only an unmatched echo
 * is attributed to the human operator. If Meta does echo Cloud API sends,
 * that path resolves correctly instead of inventing a second human author.
 *
 * `history` and `smb_app_state_sync` are recognised and reported as
 * unsupported here rather than parsed — bounded history import is a
 * separate ingestion slice (see briefs/whatsapp-coexistence-ingestion.md §5)
 * and live ingestion must not depend on it.
 *
 * This module is deliberately pure: no Supabase, no `server-only`, no
 * network. Everything provider-specific lives here so business logic never
 * reads a raw Meta field.
 */

/** Where an observed WhatsApp message came from. */
export type WhatsAppMessageOrigin =
  | 'external_contact'
  | 'business_app_operator'
  | 'caye_cloud_api'
  | 'unknown_business_origin'

/** Meta webhook fields this ingestion path understands. */
export const WHATSAPP_MESSAGES_FIELD = 'messages'
export const WHATSAPP_ECHO_FIELD = 'smb_message_echoes'

/**
 * Coexistence fields Meta documents that this milestone deliberately does
 * not ingest. Recognised so they are reported as a known gap rather than
 * landing in the same bucket as a genuinely unrecognised payload.
 */
export const WHATSAPP_DEFERRED_COEXISTENCE_FIELDS: readonly string[] = ['history', 'smb_app_state_sync']

export interface WhatsAppChangeMetadata {
  phoneNumberId: string
  displayPhoneNumber: string | null
}

export type RawWaContact = {
  wa_id?: string
  profile?: { name?: string }
}

export type RawWaMessage = {
  id?: string
  from?: string
  timestamp?: string
  type?: string
  text?: { body?: string }
  [key: string]: unknown
}

export type RawWaStatus = {
  id?: string
  status?: string
  timestamp?: string
  errors?: { code?: number; title?: string; message?: string }[]
}

export type RawWaEcho = {
  id?: string
  from?: string
  to?: string
  timestamp?: string
  type?: string
  text?: { body?: string }
  revoke?: { original_message_id?: string }
  edit?: { original_message_id?: string; message?: RawWaMessage & { type?: string } }
  [key: string]: unknown
}

/**
 * One `entry[].changes[]` entry, flattened. `supported: false` means this
 * ingestion path knowingly does nothing with it — the caller logs and moves
 * on rather than throwing, because an unknown field must never fail the
 * whole webhook delivery.
 */
export interface ParsedWhatsAppChange {
  field: string
  supported: boolean
  /** Set when `supported` is false: why this change was not ingested. */
  unsupportedReason: 'deferred_coexistence_field' | 'unrecognized_field' | 'missing_metadata' | null
  metadata: WhatsAppChangeMetadata | null
  contacts: RawWaContact[]
  messages: RawWaMessage[]
  echoes: RawWaEcho[]
  statuses: RawWaStatus[]
}

/** What kind of thing an echo describes. */
export type ObservationKind = 'message' | 'edit' | 'revoke'

/**
 * A provider event normalized into the vocabulary downstream code reasons
 * about. `counterpartyWaId` is always the CUSTOMER side of the thread —
 * that is what keys `unified_conversations.channel_conversation_id`, so an
 * echo and the customer's own replies land on the same canonical
 * conversation instead of forking a second one.
 */
export interface ObservedWhatsAppMessage {
  providerMessageId: string
  counterpartyWaId: string
  from: string
  to: string | null
  /** ISO-8601, converted from Meta's unix-seconds `timestamp`. */
  observedAt: string
  observationKind: ObservationKind
  messageType: string
  isText: boolean
  text: string | null
  /** Set for `edit` / `revoke`: the message this event amends. */
  referencedMessageId: string | null
  /** Provenance kept for audit. Never carries tokens or signatures. */
  provenance: {
    webhook_field: string
    phone_number_id: string
    display_phone_number: string | null
    provider_type: string
  }
}

function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value.filter((v) => v && typeof v === 'object') as Record<string, unknown>[]) : []
}

function readMetadata(value: Record<string, unknown> | undefined): WhatsAppChangeMetadata | null {
  const meta = value?.metadata as Record<string, unknown> | undefined
  const phoneNumberId = typeof meta?.phone_number_id === 'string' ? meta.phone_number_id : ''
  if (!phoneNumberId) return null
  const display = typeof meta?.display_phone_number === 'string' ? meta.display_phone_number : null
  return { phoneNumberId, displayPhoneNumber: display }
}

/**
 * Flattens Meta's `entry[].changes[]` envelope.
 *
 * Reads EVERY entry and change, not `entry[0].changes[0]`. Coexistence makes
 * that mandatory rather than merely tidy: an echo arrives as its own change
 * with `field: 'smb_message_echoes'`, and Meta is free to batch it alongside
 * an ordinary `messages` change in one delivery.
 */
export function parseWhatsAppWebhook(payload: unknown): ParsedWhatsAppChange[] {
  const root = (payload ?? {}) as Record<string, unknown>
  const out: ParsedWhatsAppChange[] = []

  for (const entry of asArray(root.entry)) {
    for (const change of asArray(entry.changes)) {
      const field = typeof change.field === 'string' ? change.field : ''
      const value = (change.value ?? undefined) as Record<string, unknown> | undefined
      const metadata = readMetadata(value)

      if (field !== WHATSAPP_MESSAGES_FIELD && field !== WHATSAPP_ECHO_FIELD) {
        out.push({
          field,
          supported: false,
          unsupportedReason: WHATSAPP_DEFERRED_COEXISTENCE_FIELDS.includes(field)
            ? 'deferred_coexistence_field'
            : 'unrecognized_field',
          metadata,
          contacts: [],
          messages: [],
          echoes: [],
          statuses: [],
        })
        continue
      }

      if (!metadata) {
        // No phone_number_id means no workspace can be resolved. Fail closed
        // and say why, rather than processing a change we cannot attribute.
        out.push({
          field,
          supported: false,
          unsupportedReason: 'missing_metadata',
          metadata: null,
          contacts: [],
          messages: [],
          echoes: [],
          statuses: [],
        })
        continue
      }

      out.push({
        field,
        supported: true,
        unsupportedReason: null,
        metadata,
        contacts: asArray(value?.contacts) as RawWaContact[],
        messages: field === WHATSAPP_MESSAGES_FIELD ? (asArray(value?.messages) as RawWaMessage[]) : [],
        echoes: field === WHATSAPP_ECHO_FIELD ? (asArray(value?.message_echoes) as RawWaEcho[]) : [],
        statuses: asArray(value?.statuses) as RawWaStatus[],
      })
    }
  }

  return out
}

/**
 * Meta sends `timestamp` as unix seconds in a string. A malformed value
 * yields null so the caller can skip the event rather than persist an
 * "Invalid Date" or silently substitute now() — a fabricated observation
 * time is worse than a dropped one.
 */
export function metaTimestampToISO(timestamp: unknown): string | null {
  const seconds = Number(timestamp)
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  const date = new Date(seconds * 1000)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

/**
 * Origin of an ordinary `messages` entry.
 *
 * A message on this field whose sender is the business's own number is NOT
 * claimed as the operator's: Meta does not document that shape, and the
 * whole point of coexistence is that human app sends arrive on
 * `smb_message_echoes`. It is reported as unknown, which fails closed for
 * every autonomous path.
 */
export function classifyInboundOrigin(from: string, businessPhone: string | null | undefined): WhatsAppMessageOrigin {
  const business = (businessPhone ?? '').trim()
  if (business && from === business) return 'unknown_business_origin'
  return 'external_contact'
}

/**
 * Origin of an `smb_message_echoes` entry.
 *
 * `matchedCayeSend` is the result of looking the echo's provider message id
 * up against sends Caye already recorded. See this module's header for why
 * the reconciliation input exists rather than a flat assumption.
 */
export function classifyEchoOrigin(matchedCayeSend: boolean): WhatsAppMessageOrigin {
  return matchedCayeSend ? 'caye_cloud_api' : 'business_app_operator'
}

/**
 * The single structural gate on Caye answering a WhatsApp message.
 *
 * Only a message from a party outside the business can produce an automatic
 * reply. Observing the owner's own app activity, observing Caye's own
 * output, or failing to establish authorship all return false — the last one
 * because "we do not know who wrote this" is never grounds for autonomous
 * customer contact.
 */
export function isAutoReplyEligible(origin: WhatsAppMessageOrigin): boolean {
  return origin === 'external_contact'
}

function textBodyOf(source: Record<string, unknown> | undefined, type: string): string | null {
  const node = source?.[type] as Record<string, unknown> | undefined
  const body = node?.body
  return typeof body === 'string' ? body : null
}

/**
 * Normalizes one `message_echoes[]` entry. Returns null when the echo lacks
 * the identity fields every downstream write depends on (id, to, timestamp)
 * — an unusable event is dropped with the caller logging, never guessed at.
 */
export function normalizeEcho(echo: RawWaEcho, metadata: WhatsAppChangeMetadata): ObservedWhatsAppMessage | null {
  const providerMessageId = typeof echo.id === 'string' ? echo.id : ''
  const to = typeof echo.to === 'string' ? echo.to : ''
  const from = typeof echo.from === 'string' ? echo.from : ''
  const observedAt = metaTimestampToISO(echo.timestamp)
  const providerType = typeof echo.type === 'string' ? echo.type : ''

  if (!providerMessageId || !to || !observedAt || !providerType) return null

  const provenance = {
    webhook_field: WHATSAPP_ECHO_FIELD,
    phone_number_id: metadata.phoneNumberId,
    display_phone_number: metadata.displayPhoneNumber,
    provider_type: providerType,
  }

  if (providerType === 'revoke') {
    const original = echo.revoke?.original_message_id
    if (typeof original !== 'string' || !original) return null
    return {
      providerMessageId,
      counterpartyWaId: to,
      from,
      to,
      observedAt,
      observationKind: 'revoke',
      messageType: 'revoke',
      isText: false,
      text: null,
      referencedMessageId: original,
      provenance,
    }
  }

  if (providerType === 'edit') {
    const original = echo.edit?.original_message_id
    const edited = echo.edit?.message
    const editedType = typeof edited?.type === 'string' ? edited.type : ''
    if (typeof original !== 'string' || !original || !edited || !editedType) return null
    const isText = editedType === 'text'
    return {
      providerMessageId,
      counterpartyWaId: to,
      from,
      to,
      observedAt,
      observationKind: 'edit',
      messageType: editedType,
      isText,
      text: isText ? textBodyOf(edited as Record<string, unknown>, 'text') : null,
      referencedMessageId: original,
      provenance,
    }
  }

  const isText = providerType === 'text'
  return {
    providerMessageId,
    counterpartyWaId: to,
    from,
    to,
    observedAt,
    observationKind: 'message',
    messageType: providerType,
    isText,
    text: isText ? textBodyOf(echo as Record<string, unknown>, 'text') : null,
    referencedMessageId: null,
    provenance,
  }
}
