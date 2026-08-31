import { founderBriefingLeak } from './operator-text-guard'

export interface AttentionPresentationInput {
  subjectType: string
  title?: string | null
  customerName?: string | null
  customerEmail?: string | null
  customerPhone?: string | null
  serviceName?: string | null
  /** Human-safe qualifier used only when two visible subjects would otherwise collide. */
  disambiguator?: string | null
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
  const disambiguator = stripInternalIdentifiers(input.disambiguator?.trim() ?? '')
  if (name) return disambiguator ? `${name} (${disambiguator})` : name
  const email = input.customerEmail?.trim()
  if (email) return email
  const phone = input.customerPhone?.trim()
  if (phone) return phone
  return null
}

export function attentionSubjectLabel(input: AttentionPresentationInput): string {
  const who = identity(input)
  const service = stripInternalIdentifiers(input.serviceName?.trim() ?? '')
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
    case 'decision': return 'business decision'
    default: return 'attention item'
  }
}

export function presentAttentionOutcome(input: AttentionPresentationInput): string {
  const subject = attentionSubjectLabel(input)
  const action = stripInternalIdentifiers(input.action ?? '').replace(/[.!]+$/, '')
  const sentence = action ? `${action} ${subject}.` : `Updated ${subject}.`
  return hasInternalIdentifierLeak(sentence) ? 'Updated the attention item.' : sentence
}

/**
 * Last-mile repair for legacy operator prose that already contains a raw id.
 * It deliberately does not expose the id and does not pretend an unknown id is
 * a customer name. Rich call sites should use attentionSubjectLabel instead.
 */
export function humanizeLegacyAttentionText(text: string): string {
  const clean = stripInternalIdentifiers(text)
  if (/^Skipped held thread\b/i.test(clean)) return 'Removed the held customer conversation from the queue.'
  return clean
}
