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

/**
 * Semantic context for HOW already-approved meaning should be realized.
 *
 * This deliberately carries no permission to perform an action. Authority,
 * truth, approval gates, and tool execution remain owned by the existing
 * control layer. The realization layer can only make approved meaning more
 * conversational, never make an unsafe action permissible.
 */
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

const SHORT_TURN_WORDS = 8

export function isShortConversationalTurn(text: string | null | undefined): boolean {
  if (!text?.trim()) return false
  return text.trim().split(/\s+/).length <= SHORT_TURN_WORDS
}

/**
 * Deterministic communication policy. This is the seam between Caye's
 * rigorous internal control representation and the prose the human sees.
 */
export function planCommunication(ctx: CommunicationContext): CommunicationPlan {
  const structured = ctx.explicitStructuredReport || ctx.purpose === 'structured_report'
  const mustResurface =
    ctx.decisionRequired ||
    ctx.materialSafetyInformation ||
    ctx.urgencyIncreased ||
    ctx.deadlineApproaching

  let resurfacing: ResurfacingMode = 'full'
  if (ctx.previouslyMentioned && !ctx.changedSinceLastMention) {
    resurfacing = mustResurface ? 'compressed' : 'suppress'
  } else if (ctx.previouslyMentioned) {
    resurfacing = 'compressed'
  }

  let detail: CommunicationDetail = structured ? 'structured' : 'normal'
  if (
    !structured &&
    isShortConversationalTurn(ctx.priorTurn) &&
    !ctx.materialSafetyInformation &&
    ctx.purpose !== 'analytical_response'
  ) {
    detail = 'terse'
  }
  if (ctx.purpose === 'acknowledgement' && !ctx.materialSafetyInformation && !structured) {
    detail = 'terse'
  }
  if (ctx.purpose === 'analytical_response' && !structured) detail = 'detailed'

  return {
    detail,
    resurfacing,
    cta: ctx.decisionRequired && ctx.responseRequired ? 'decision' : 'none',
    acknowledgeAuthorityFirst: Boolean(ctx.authoritativeOperatorCorrection),
    exposeInternalTaxonomy: Boolean(structured),
    preserveUncertainty: Boolean(ctx.materialUncertainty),
    preserveAuthorityRequirement:
      Boolean(ctx.decisionRequired) && Boolean(ctx.authorityRequirement && ctx.authorityRequirement !== 'none'),
  }
}

/**
 * Prompt fragment used by existing primary model calls. It does not add a
 * second model pass. The model receives a deterministic communication plan
 * alongside the operational facts/tool results it already has.
 */
export function buildCommunicationRealizationInstructions(ctx: CommunicationContext): string {
  const plan = planCommunication(ctx)
  const lines = [
    'HUMAN COMMUNICATION REALIZATION',
    'The operational/control state determines WHAT is true, allowed, blocked, uncertain, or approval-gated. These instructions only determine HOW that approved meaning is expressed.',
    `Recipient: ${ctx.recipientRole}. Channel: ${ctx.channel}. Purpose: ${ctx.purpose}.`,
    `Detail: ${plan.detail}. Resurfacing: ${plan.resurfacing}. CTA: ${plan.cta}.`,
  ]

  if (plan.resurfacing === 'suppress') {
    lines.push('This issue was already surfaced and has not materially changed. Do not reconstruct or re-announce it. Omit it unless the current human message directly asks about it.')
  } else if (plan.resurfacing === 'compressed') {
    lines.push('Shared context exists. Refer to the issue briefly using normal conversational reference; do not rebuild its database history or mini-report.')
  }

  if (plan.acknowledgeAuthorityFirst) {
    lines.push("An authoritative operator has corrected or closed the conversational point. Acknowledge that naturally first. Keep reconciliation/checking internal unless a remaining discrepancy materially changes safety or the next action.")
  }

  if (plan.cta === 'none') {
    lines.push('No decision is required now. End the update without inventing a question, offer, permission check, or "want me to" CTA.')
  } else {
    lines.push('A real decision is required. Ask one natural, precise question that makes the required authority/approval unambiguous. Do not turn it into a generic "Proceed? Yes or No." template.')
  }

  if (!plan.exposeInternalTaxonomy) {
    lines.push('Do not mechanically expose internal field names, enum labels, queue state, status labels, or report headings such as Decision / Why it matters / What has been done / Recommendation. Translate the approved meaning into ordinary prose.')
  } else {
    lines.push('The user explicitly requested structured reporting. Structure is allowed, but internal identifiers and implementation-only taxonomy still stay private.')
  }

  if (plan.detail === 'terse') {
    lines.push('Match the conversational bandwidth: this should usually be a short acknowledgement or one short message, not a paragraph.')
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
