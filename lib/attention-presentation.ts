import { founderBriefingLeak } from './operator-text-guard'

/**
 * Canonical human-facing presentation for attention subjects.
 *
 * Internal IDs remain durable audit/evidence keys. They are never the fallback
 * label for an operator. If we cannot resolve a business identity, we describe
 * the kind of work rather than dumping a UUID into the conversation.
 */
export interface AttentionPresentationInput {
  subjectType: string
  title?: string | null
  customerName?: string | null
  customerEmail?: string | null
  customerPhone?: string | null
  serviceName?: string | null
  action?: string | null
}

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi
const INTERNAL_ID = /\b(?:conversation|thread|attention|queue|objective|action|operation)[_-]?(?:id)?\s*[:#=]?\s*[0-9a-f-]{12,}\b/gi

export function stripInternalIdentifiers(text: string): string {
  return text.replace(UUID, '').replace(INTERNAL_ID, '').replace(/\s{2,}/g, ' ').trim()
}

export function hasInternalIdentifierLeak(text: string): boolean {
  UUID.lastIndex = 0
  INTERNAL_ID.lastIndex = 0
  return UUID.test(text) || INTERNAL_ID.test(text) || Boolean(founderBriefingLeak(text))
}

function identity(input: AttentionPresentationInput): string | null {
  const name = input.customerName?.trim()
  if (name) return name
  const email = input.customerEmail?.trim()
  if (email) return email
  const phone = input.customerPhone?.trim()
  if (phone) return phone
  return null
}

export function attentionSubjectLabel(input: AttentionPresentationInput): string {
  const who = identity(input)
  const service = input.serviceName?.trim()
  if (who && service) return `${who}'s ${service}`
  if (who) return who
  if (service) return service

  const cleanTitle = stripInternalIdentifiers(input.title ?? '')
  if (cleanTitle && !hasInternalIdentifierLeak(cleanTitle)) return cleanTitle

  switch (input.subjectType) {
    case 'conversation': return 'customer conversation'
    case 'reminder': return 'operator reminder'
    case 'booking': return 'customer booking'
    case 'payment': return 'customer payment'
    case 'objective': return 'operator objective'
    default: return 'attention item'
  }
}

export function presentAttentionOutcome(input: AttentionPresentationInput): string {
  const subject = attentionSubjectLabel(input)
  const action = stripInternalIdentifiers(input.action ?? '').replace(/[.!]+$/, '')
  const sentence = action ? `${action} ${subject}.` : `Updated ${subject}.`
  if (hasInternalIdentifierLeak(sentence)) return 'Updated the attention item.'
  return sentence
}
