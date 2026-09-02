export type CommunicationPurpose =
  | 'acknowledgement'
  | 'informational_update'
  | 'approval_request'
  | 'reminder'
  | 'escalation'
  | 'customer_reply'
  | 'analytical_response'
  | 'structured_report'

export type CommunicationRecipientRole = 'owner' | 'operator' | 'customer' | 'internal'
export type CommunicationChannel = 'whatsapp' | 'email' | 'dashboard' | 'proactive' | 'other'
export type CommunicationDetail = 'terse' | 'normal' | 'detailed' | 'structured'
export type ResurfacingMode = 'full' | 'compressed' | 'suppress'

export interface CommunicationContext {
  purpose: CommunicationPurpose
  recipientRole: CommunicationRecipientRole
  channel: CommunicationChannel
  responseRequired: boolean
  decisionRequired: boolean
  previouslyMentioned?: boolean
  changedSinceLastMention?: boolean
  priorTurn?: string | null
  authoritativeOperatorCorrection?: boolean
  authorityRequirement?: 'owner' | 'operator' | 'none' | null
  materialUncertainty?: boolean
  explicitStructuredReport?: boolean
  materialSafetyInformation?: boolean
  urgencyIncreased?: boolean
  deadlineApproaching?: boolean
}

export interface CommunicationPlan {
  detail: CommunicationDetail
  resurfacing: ResurfacingMode
  cta: 'none' | 'decision'
  acknowledgeAuthorityFirst: boolean
  exposeInternalTaxonomy: boolean
  preserveUncertainty: boolean
  preserveAuthorityRequirement: boolean
}

const SHORT_TURN_WORDS = 12

export function isShortConversationalTurn(text: string | null | undefined): boolean {
  if (!text?.trim()) return false
  return text.trim().split(/\s+/).length <= SHORT_TURN_WORDS
}

/** Deterministic seam between operational/control state and human prose. */
export function planCommunication(ctx: CommunicationContext): CommunicationPlan {
  const structured = ctx.explicitStructuredReport || ctx.purpose === 'structured_report'
  const materiallyChanged = Boolean(
    ctx.changedSinceLastMention ||
    ctx.materialSafetyInformation ||
    ctx.urgencyIncreased ||
    ctx.deadlineApproaching
  )

  let resurfacing: ResurfacingMode = 'full'
  if (ctx.previouslyMentioned && !materiallyChanged) {
    // An unresolved item is not automatically new information. Once surfaced,
    // leave it out until it changes or the human directly asks about it.
    resurfacing = 'suppress'
  } else if (ctx.previouslyMentioned) {
    resurfacing = 'compressed'
  }

  let detail: CommunicationDetail = structured ? 'structured' : 'terse'
  if (ctx.purpose === 'analytical_response' && !structured) detail = 'detailed'
  if (ctx.materialSafetyInformation && !structured) detail = 'normal'

  const decisionCtaAllowed =
    ctx.decisionRequired &&
    ctx.responseRequired &&
    resurfacing !== 'suppress'

  return {
    detail,
    resurfacing,
    cta: decisionCtaAllowed ? 'decision' : 'none',
    acknowledgeAuthorityFirst: Boolean(ctx.authoritativeOperatorCorrection),
    exposeInternalTaxonomy: false,
    preserveUncertainty: Boolean(ctx.materialUncertainty),
    preserveAuthorityRequirement:
      decisionCtaAllowed && Boolean(ctx.authorityRequirement && ctx.authorityRequirement !== 'none'),
  }
}

/**
 * Prompt fragment used by the existing primary model call. It adds no second
 * LLM pass and cannot grant operational authority.
 */
export function buildCommunicationRealizationInstructions(ctx: CommunicationContext): string {
  const plan = planCommunication(ctx)
  const structured = ctx.explicitStructuredReport || ctx.purpose === 'structured_report'
  const lines = [
    'HUMAN COMMUNICATION REALIZATION',
    'The operational/control state determines WHAT is true, allowed, blocked, uncertain, or approval-gated. These instructions only determine HOW that approved meaning is expressed.',
    `Recipient: ${ctx.recipientRole}. Channel: ${ctx.channel}. Purpose: ${ctx.purpose}.`,
    `Detail: ${plan.detail}. Resurfacing: ${plan.resurfacing}. CTA: ${plan.cta}.`,
    'Default to the shortest complete answer. For normal conversation, one to three short sentences is the target.',
  ]

  if (plan.resurfacing === 'suppress') {
    lines.push('This issue or action request was already surfaced and has not materially changed. Do not mention it again, do not repeat its approval question, and do not reconstruct its history unless the current human message directly asks about it.')
  } else if (plan.resurfacing === 'compressed') {
    lines.push('Shared context exists and something materially changed. State only the change and the current consequence. Do not rebuild the history.')
  }

  if (plan.acknowledgeAuthorityFirst) {
    lines.push("An authoritative operator has corrected or closed the conversational point. Acknowledge it briefly and move on. Keep reconciliation/checking internal unless a remaining discrepancy materially changes safety or the next action.")
  }

  if (plan.cta === 'none') {
    lines.push('No decision is required in this answer. End without a question, offer, permission check, or CTA.')
  } else {
    lines.push('A real decision is required in this turn. Ask exactly one short, precise question. Do not ask it again on later turns unless the situation materially changes or the human returns to that issue.')
  }

  lines.push('Do not mechanically expose internal field names, enum labels, queue state, status labels, or report headings such as Decision / Why it matters / What has been done / Recommendation. Translate the approved meaning into ordinary prose.')
  if (structured) {
    lines.push('The user explicitly requested structured reporting. Give the requested detail with useful headings or bullets, but keep each item concise and keep implementation-only taxonomy private.')
  }

  if (plan.detail === 'terse') {
    lines.push('Keep this extremely short. Prefer one sentence. Use two or three only when needed for an important fact or next action.')
  }
  if (plan.preserveAuthorityRequirement) {
    lines.push(`Do not blur authority: the required ${ctx.authorityRequirement} approval must remain explicit in the human wording.`)
  }
  if (plan.preserveUncertainty) {
    lines.push('Material uncertainty is part of the approved meaning. Preserve it explicitly; do not smooth it into certainty for the sake of natural voice.')
  }

  lines.push('Never imply an action happened unless the control/tool result says it happened. Never turn inference into fact. Never fabricate shared context or familiarity.')
  return lines.join('\n')
}
