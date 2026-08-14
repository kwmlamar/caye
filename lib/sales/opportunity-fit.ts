import type { OpportunityConfidence } from '@/lib/caye-relationships'

export interface SalesWorkOpportunityCandidate {
  opportunityType: 'customer_communication'
  capabilityKey: 'customer_inbox_response'
  subjectKey: 'customer_inquiry_response'
  description: string
  inference: string
  confidence: OpportunityConfidence
  observedFact: string
}

// Phase 2 persists only explicit, direct statements of a current Caye fit.
// Industry, business name, and generic curiosity deliberately produce no work.
const DIRECT_INBOX_NEED = /\b(?:need help|need someone|can(?:not|'t)|cannot|struggl(?:e|ing)|having trouble|overwhelmed)\b[^.!?]{0,140}\b(?:answer(?:ing)?|respond(?:ing)?|keep(?:ing)? up with|manag(?:ing)?)\b[^.!?]{0,100}\b(?:customer )?(?:messages|inquiries|enquiries|emails|whatsapps?)\b/i

function conciseSnapshot(match: string): string {
  return match.replace(/\s+/g, ' ').trim().slice(0, 280)
}

/**
 * Deterministic capability-fit gate for the only presently proven Sales fit:
 * a prospect directly describes difficulty answering customer inquiries.
 */
export function deriveSalesWorkOpportunity(body: string | null | undefined): SalesWorkOpportunityCandidate | null {
  const match = body?.match(DIRECT_INBOX_NEED)
  if (!match?.[0]) return null
  return {
    opportunityType: 'customer_communication',
    capabilityKey: 'customer_inbox_response',
    subjectKey: 'customer_inquiry_response',
    description: 'Handle inbound customer inquiries and replies.',
    inference: 'Caye could help by responding to customer inquiries.',
    confidence: 'high',
    observedFact: `Prospect directly stated: “${conciseSnapshot(match[0])}”`,
  }
}
