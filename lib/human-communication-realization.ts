import { HUMAN_FACING_VOICE_INSTRUCTIONS } from './human-facing-voice'

export type CommunicationRecipientRole =
  | 'operator'
  | 'owner'
  | 'staff'
  | 'customer'
  | 'prospect'
  | 'unknown'

export type HumanCommunicationChannel = 'dashboard' | 'whatsapp' | 'email' | 'meta' | 'other'

export type HumanCommunicationPurpose =
  | 'acknowledgement'
  | 'informational_update'
  | 'issue_update'
  | 'approval_request'
  | 'reminder'
  | 'briefing'
  | 'structured_report'
  | 'other'

export type CommunicationUrgency = 'routine' | 'important' | 'urgent'
export type SharedContextAmount = 'low' | 'medium' | 'high'

export interface HumanCommunicationContext {
  recipientRole: CommunicationRecipientRole
  channel: HumanCommunicationChannel
  purpose: HumanCommunicationPurpose
  responseRequired: boolean
  approvalRequired: boolean
  authorityHolder?: 'caye' | 'operator' | 'owner' | 'staff' | 'external' | 'unknown' | null
  urgency?: CommunicationUrgency
  materialUncertainty?: boolean
  issuePreviouslyMentioned?: boolean
  anythingChanged?: boolean
  priorConversationalContext?: boolean
  sharedContext?: SharedContextAmount
  structuredOutputRequested?: boolean
  shortOperatorInput?: boolean
}

export interface HumanCommunicationPolicy {
  mode: 'brief_acknowledgement' | 'suppress' | 'compressed' | 'natural' | 'structured'
  askForResponse: boolean
  requireApprovalRequest: boolean
  preserveUncertainty: boolean
  exposeInternalTaxonomy: boolean
  maxSentences: number | null
}

/**
 * Decide how approved operational meaning should be realized for a person.
 *
 * This does not change authority, safety, or operational state. It only says
 * how much of that already-approved meaning should be surfaced and whether a
 * human action must be requested. Keeping this deterministic prevents prompt
 * drift from turning every status update into a miniature incident report.
 */
export function deriveHumanCommunicationPolicy(
  context: HumanCommunicationContext
): HumanCommunicationPolicy {
  const structured = context.structuredOutputRequested || context.purpose === 'structured_report'
  const approvalRequired = context.approvalRequired === true
  const uncertainty = context.materialUncertainty === true

  if (structured) {
    return {
      mode: 'structured',
      askForResponse: context.responseRequired || approvalRequired,
      requireApprovalRequest: approvalRequired,
      preserveUncertainty: uncertainty,
      exposeInternalTaxonomy: false,
      maxSentences: null,
    }
  }

  if (
    context.purpose === 'acknowledgement' &&
    context.shortOperatorInput &&
    !approvalRequired &&
    !uncertainty
  ) {
    return {
      mode: 'brief_acknowledgement',
      askForResponse: false,
      requireApprovalRequest: false,
      preserveUncertainty: false,
      exposeInternalTaxonomy: false,
      maxSentences: 2,
    }
  }

  if (
    context.issuePreviouslyMentioned &&
    context.anythingChanged === false &&
    !approvalRequired &&
    !uncertainty &&
    !context.responseRequired
  ) {
    return {
      mode: 'suppress',
      askForResponse: false,
      requireApprovalRequest: false,
      preserveUncertainty: false,
      exposeInternalTaxonomy: false,
      maxSentences: 1,
    }
  }

  if (context.issuePreviouslyMentioned && context.anythingChanged === false) {
    return {
      mode: 'compressed',
      askForResponse: context.responseRequired || approvalRequired,
      requireApprovalRequest: approvalRequired,
      preserveUncertainty: uncertainty,
      exposeInternalTaxonomy: false,
      maxSentences: approvalRequired || uncertainty ? 2 : 1,
    }
  }

  const shortConversational =
    context.shortOperatorInput ||
    (context.priorConversationalContext && context.sharedContext === 'high')

  return {
    mode: 'natural',
    askForResponse: context.responseRequired || approvalRequired,
    requireApprovalRequest: approvalRequired,
    preserveUncertainty: uncertainty,
    exposeInternalTaxonomy: false,
    maxSentences: shortConversational && context.urgency !== 'urgent' ? 2 : null,
  }
}

/**
 * Shared semantic realization instructions for human-facing LLM generation.
 * Operational prompts can keep rich internal state. This block controls only
 * how the approved meaning is expressed to the recipient.
 */
export function buildHumanCommunicationRealizationInstructions(
  context: HumanCommunicationContext
): string {
  const policy = deriveHumanCommunicationPolicy(context)
  const lines = [
    HUMAN_FACING_VOICE_INSTRUCTIONS,
    '',
    'HUMAN COMMUNICATION REALIZATION:',
    '- Treat operational status, authority, approval gates, tool results, and safety rules as internal control structure. Preserve their meaning, but do not mechanically narrate their field names or taxonomy.',
    '- Communicate only what this recipient needs for this purpose and this turn. Shared context is shared context: do not restate it just to make the answer look complete.',
    '- Do not add a call to action, offer, question, or "Want me to..." ending unless a response or decision is actually required.',
    '- If the person already corrected or resolved an item, acknowledge that naturally. Reconcile internal state separately unless a material discrepancy changes safety, money, commitment, or the next action.',
    '- Never expose internal labels such as status=held, authority=owner, approval_required=true, confidence fields, routing labels, or queue taxonomy as prose unless the person explicitly asked for diagnostic/internal details.',
    '- Preserve material uncertainty explicitly. Natural wording must never turn an unknown, estimate, or unresolved fact into certainty.',
    '- If approval is required, ask for that approval clearly and preserve who has authority. Natural wording must not weaken or bypass the gate.',
  ]

  if (policy.mode === 'brief_acknowledgement') {
    lines.push('- This turn is a brief acknowledgement. Usually one sentence, at most two. Do not re-litigate the issue or dump database state.')
  } else if (policy.mode === 'suppress') {
    lines.push('- This issue was already surfaced and nothing changed. Omit it unless it is necessary to avoid a misleading message.')
  } else if (policy.mode === 'compressed') {
    lines.push('- This issue was already surfaced and nothing changed. Refer to it in one compact clause or sentence. Do not reconstruct its history.')
  } else if (policy.mode === 'structured') {
    lines.push('- The person explicitly requested structured output. Use the requested report, breakdown, table, or decision-summary structure while keeping the wording human.')
  }

  if (!policy.askForResponse) {
    lines.push('- No response is required. End after the useful information. Do not manufacture interactivity.')
  }
  if (policy.requireApprovalRequest) {
    lines.push('- A real approval gate is open. End with one specific, naturally worded approval request that makes the authority boundary clear.')
  }
  if (policy.preserveUncertainty) {
    lines.push('- Material uncertainty is present. State what is not known or confirmed in plain language.')
  }
  if (policy.maxSentences != null) {
    lines.push(`- Length target for this turn: no more than ${policy.maxSentences} short sentence${policy.maxSentences === 1 ? '' : 's'} unless material safety information requires more.`)
  }

  return lines.join('\n')
}

export interface RealizationFixture {
  context: HumanCommunicationContext
  acknowledgement?: string
  update?: string
  repeatedReference?: string
  approvalRequest?: string
  uncertainty?: string
}

/**
 * Small deterministic renderer used for high-confidence communication seams
 * and regression fixtures. It is intentionally not a general prose engine.
 */
export function realizeHumanCommunicationFixture(input: RealizationFixture): string {
  const policy = deriveHumanCommunicationPolicy(input.context)

  if (policy.mode === 'brief_acknowledgement') {
    return (input.acknowledgement || "Got it. I'll leave that one alone.").trim()
  }

  if (policy.mode === 'suppress') return ''

  const parts: string[] = []
  if (policy.mode === 'compressed' && input.repeatedReference) {
    parts.push(input.repeatedReference.trim())
  } else if (input.update) {
    parts.push(input.update.trim())
  }

  if (policy.preserveUncertainty && input.uncertainty) {
    parts.push(input.uncertainty.trim())
  }

  if (policy.requireApprovalRequest && input.approvalRequest) {
    parts.push(input.approvalRequest.trim())
  }

  return parts.filter(Boolean).join(' ').trim()
}
