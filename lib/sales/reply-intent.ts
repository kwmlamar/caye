/**
 * The next conversational move for a real Sales reply. This is deliberately
 * small: obvious language is deterministic; anything else is ambiguity, not
 * an excuse to put Lamar in the loop.
 */
export type SalesReplyIntent =
  | 'value_proposition_question'
  | 'how_it_works'
  | 'capability_question'
  | 'pricing_question'
  | 'pricing_exception'
  | 'interested'
  | 'demo_request'
  | 'explicit_work_request'
  | 'objection'
  | 'not_interested'
  | 'referral'
  | 'wrong_contact'
  | 'out_of_office'
  | 'ambiguity'
  | 'human_requested'
  | 'unsupported_commitment'

export type SalesConversationAction =
  | 'ANSWER'
  | 'ASK_CLARIFICATION'
  | 'ADVANCE_TO_TRIAL_OR_WORK'
  | 'ANSWER_AND_PROPOSE_WORK'
  | 'DISQUALIFY'
  | 'ESCALATE'

export interface SalesReplyClassification {
  intent: SalesReplyIntent
  nextAction: SalesConversationAction
}

/** Known, low-risk conversational intents must not be converted to review by model hesitation. */
export function requiresAutonomousSalesReply(intent: SalesReplyIntent): boolean {
  return ['value_proposition_question', 'how_it_works', 'pricing_question', 'interested', 'demo_request', 'objection', 'not_interested', 'referral', 'wrong_contact', 'ambiguity'].includes(intent)
}

const matches = (text: string, expression: RegExp) => expression.test(text)

/** Classifies only clear, low-risk phrases; semantic remainder asks Caye to clarify. */
export function classifySalesReplyIntent(body: string | null | undefined): SalesReplyClassification {
  const text = (body ?? '').trim().toLowerCase()
  if (matches(text, /\b(?:wrong person|not the right person)\b/)) return { intent: 'wrong_contact', nextAction: 'DISQUALIFY' }
  if (/\b(?:talk|speak|connect|contact)\s+(?:with\s+)?(?:a\s+)?(?:human|person|founder|lamar|someone)\b/.test(text)) return { intent: 'human_requested', nextAction: 'ESCALATE' }
  if (/\b(?:guarantee|guaranteed|promise)\b/.test(text)) return { intent: 'unsupported_commitment', nextAction: 'ESCALATE' }
  if (/\b(?:\d{1,3}%\s+off|discount|negotiate|price match|match (?:competitor|another) pricing|custom pricing)\b/.test(text)) return { intent: 'pricing_exception', nextAction: 'ESCALATE' }
  if (matches(text, /\b(?:not interested|no thanks)\b/)) return { intent: 'not_interested', nextAction: 'DISQUALIFY' }
  if (matches(text, /\b(?:can you|could you).{0,50}\b(?:handle|answer|respond to)\b/)) return { intent: 'explicit_work_request', nextAction: 'ADVANCE_TO_TRIAL_OR_WORK' }
  if (matches(text, /\b(?:advantages?|why (?:should|would)|what(?:'s| is) different|why (?:do|would) i need)\b/)) return { intent: 'value_proposition_question', nextAction: 'ANSWER_AND_PROPOSE_WORK' }
  if (matches(text, /\bhow (?:does|do|would).{0,40}(?:work|caye)\b/)) return { intent: 'how_it_works', nextAction: 'ANSWER_AND_PROPOSE_WORK' }
  if (matches(text, /\bwhat (?:can|does).{0,30}(?:do|handle)|\b(?:can you|do you) (?:handle|work with|use)\b/)) return { intent: 'capability_question', nextAction: 'ANSWER_AND_PROPOSE_WORK' }
  if (matches(text, /\b(?:how much|price|cost|pricing)\b/)) return { intent: 'pricing_question', nextAction: 'ANSWER' }
  if (matches(text, /\b(?:interested|tell me more|sounds good)\b/)) return { intent: 'interested', nextAction: 'ADVANCE_TO_TRIAL_OR_WORK' }
  if (matches(text, /\b(?:demo|try it|trial)\b/)) return { intent: 'demo_request', nextAction: 'ADVANCE_TO_TRIAL_OR_WORK' }
  if (matches(text, /\b(?:already have (?:human )?(?:staff|someone)|already use|another system|ai (?:isn't|is not) reliable|don't get many messages|expensive)\b/)) return { intent: 'objection', nextAction: 'ANSWER_AND_PROPOSE_WORK' }
  if (matches(text, /\b(?:speak to|contact|refer).{0,50}\b(?:someone|person|owner|manager)\b/)) return { intent: 'referral', nextAction: 'ASK_CLARIFICATION' }
  return { intent: 'ambiguity', nextAction: 'ASK_CLARIFICATION' }
}
