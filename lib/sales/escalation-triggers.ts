/**
 * escalation-triggers.ts
 *
 * Situations Caye must hand to Lamar, detected before the model gets a
 * chance to talk itself out of it.
 *
 * WHY (2026-08-12)
 * "Escalate when it feels consequential" is a prompt instruction, which is
 * to say it is advice. The categories below are ones where being wrong is
 * expensive and irreversible — a contract, a refund, a press quote, a
 * partnership — so detection runs as literal text matching over the
 * prospect's inbound message, pre-LLM, on the same principle as
 * lib/standing-rules.ts: deliberately dumb, therefore unfakeable.
 *
 * Deliberately NOT exhaustive-by-cleverness. A regex zoo that tries to
 * catch every phrasing produces false positives, and an escalation trigger
 * that fires constantly turns Lamar back into an approval queue, which is
 * the exact failure this whole redesign exists to avoid. These are the
 * high-cost cases stated plainly; the model is separately instructed to
 * escalate anything it genuinely cannot ground, and `claims.ts` catches
 * fabrication independently.
 */

export type EscalationCategory =
  | 'pricing_negotiation'
  | 'legal_or_contract'
  | 'partnership'
  | 'press_or_media'
  | 'refund_or_billing'
  | 'security_or_privacy'
  | 'large_account'
  | 'complaint'

export interface EscalationTrigger {
  category: EscalationCategory
  /** Lowercase literal phrases; matched on word boundaries. */
  phrases: readonly string[]
  /** Shown to Lamar so he knows why it landed in his lap. */
  why: string
}

export const ESCALATION_TRIGGERS: readonly EscalationTrigger[] = [
  {
    category: 'pricing_negotiation',
    phrases: [
      'discount', 'cheaper', 'lower price', 'better price', 'negotiate',
      'price match', 'too expensive', 'reduce the price', 'deal on price',
      'annual plan', 'pay yearly', 'bulk price',
    ],
    why: 'They are pushing on price. Only you can move a number or invent a plan.',
  },
  {
    category: 'legal_or_contract',
    phrases: [
      'contract', 'terms and conditions', 'sla', 'service level agreement',
      'msa', 'nda', 'liability', 'indemnity', 'legal team', 'our lawyer',
      'procurement', 'vendor agreement', 'sign an agreement',
    ],
    why: 'Contractual or legal commitment. Not something Caye can agree to.',
  },
  {
    category: 'partnership',
    phrases: [
      'partnership', 'partner with', 'reseller', 'white label', 'affiliate',
      'refer clients', 'work together', 'joint venture', 'investment',
      'invest in', 'acquire',
    ],
    why: 'Partnership or investment approach. Founder-level relationship call.',
  },
  {
    category: 'press_or_media',
    phrases: [
      'journalist', 'reporter', 'press', 'interview', 'podcast', 'article about',
      'writing a story', 'media inquiry', 'quote for',
    ],
    why: 'Media inquiry. Anything Caye says here is on the record.',
  },
  {
    category: 'refund_or_billing',
    phrases: [
      'refund', 'charge back', 'chargeback', 'billed twice', 'double charged',
      'cancel my subscription', 'stop billing', 'money back', 'invoice',
    ],
    why: 'Money moving back out. Outside any policy Caye is authorised to apply.',
  },
  {
    category: 'security_or_privacy',
    phrases: [
      'gdpr', 'data protection', 'where is my data', 'data stored',
      'security review', 'security questionnaire', 'soc 2', 'soc2',
      'penetration test', 'encryption', 'hipaa', 'privacy policy',
      'delete my data', 'who can see',
    ],
    why: 'Security or privacy question. Wrong answers here are both a trust and a legal problem.',
  },
  {
    category: 'large_account',
    phrases: [
      'locations', 'franchise', 'chain', 'our team of', 'enterprise',
      'multiple businesses', 'all our branches', 'head office',
    ],
    why: 'Looks bigger than a single owner-operated business. Worth your judgment on fit and price.',
  },
  {
    category: 'complaint',
    phrases: [
      'stop emailing', 'stop contacting', 'harassment', 'spam', 'report you',
      'complaint', 'unacceptable', 'rude', 'lawyer up', 'sue',
    ],
    why: 'They are upset. A wrong autonomous reply makes this materially worse.',
  },
]

export interface TriggerMatch {
  category: EscalationCategory
  phrase: string
  why: string
}

/**
 * Literal word-boundary containment, no regex metacharacters, no stemming.
 * Same matcher shape as lib/standing-rules.ts's buildMatcher — chosen there
 * for the same reason: an owner (or a prospect) should never be able to
 * craft text that manipulates matching behaviour.
 */
function containsPhrase(haystack: string, phrase: string): boolean {
  const h = ` ${haystack.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `
  const p = ` ${phrase.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `
  return h.includes(p)
}

/** All categories the inbound text trips. Empty means nothing matched. */
export function findEscalationTriggers(inboundText: string): TriggerMatch[] {
  if (!inboundText?.trim()) return []
  const matches: TriggerMatch[] = []
  for (const trigger of ESCALATION_TRIGGERS) {
    for (const phrase of trigger.phrases) {
      if (containsPhrase(inboundText, phrase)) {
        matches.push({ category: trigger.category, phrase, why: trigger.why })
        break
      }
    }
  }
  return matches
}

/**
 * What the prospect sees when Caye stops and hands over. Deliberately vague
 * about the reason and free of any commitment, matching the locked-template
 * discipline in lib/forced-escalation.ts: a controlled string costs no
 * tokens and cannot drift between calls.
 *
 * Note it does not apologise or promise a timeframe. "I'll get you an
 * answer" is honest; "Lamar will call you tomorrow" is a commitment Caye
 * has no standing to make on his calendar.
 */
export function customerFacingHandoff(category: EscalationCategory): string {
  if (category === 'complaint') {
    return 'Thanks for telling me straight. Let me get Lamar on this directly.'
  }
  if (category === 'press_or_media') {
    return 'Thanks for reaching out. Passing this to Lamar, he handles these himself.'
  }
  return 'Good question, and one for Lamar rather than me. Let me get you an answer.'
}
