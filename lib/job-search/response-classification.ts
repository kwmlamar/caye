export type ResponseClassification =
  | 'rejection'
  | 'recruiter_interest'
  | 'screen_request'
  | 'interview_request'
  | 'assessment'
  | 'additional_information'
  | 'scheduling'
  | 'offer'
  | 'unknown'

export type InboundClassification = ResponseClassification | 'confirmation_check'
export type ResponseDrivenApplicationStatus = 'REJECTED' | 'OFFER' | 'INTERVIEW' | 'FOLLOWUP_DUE'

const CONFIRMATION = /\b(application (?:was |has been )?(?:received|submitted)|thanks? for applying|application confirmation|we('| ha)ve received your application)\b/i
const REJECTION = /\b(unfortunately|regret to inform|will not be moving forward|decided not to move forward|will not be proceeding|not moving forward with your (?:application|candidacy)|not selected for (?:this|the) (?:role|position)|pursue other candidates|position has been filled|move forward with other candidates|not (?:be )?(?:a fit|the right fit)|will not be extending an offer|closing (?:out|this) (?:your |the )?application)\b/i
const OFFER = /\b(pleased to (?:offer|extend)|(?:extend|extending) (?:you )?an offer|offer letter|excited to offer you the (?:role|position)|welcome to the team|formal offer|verbal offer)\b/i
const INTERVIEW_REQUEST = /\b(schedule (?:an |your )?interview|would like to (?:invite you to |set up an )?interview|interview (?:availability|invite|invitation|request)|panel interview|onsite interview|virtual interview|final round|move (?:you )?(?:forward )?to (?:the )?interview stage|next step is an interview)\b/i
const SCREEN_REQUEST = /\b(phone screen|recruiter screen|intro(?:ductory)? call|initial (?:call|conversation)|quick call to (?:discuss|chat|connect)|screening call|(?:connect|chat) (?:with you )?(?:for|over) (?:a )?(?:quick )?call)\b/i
const ASSESSMENT = /\b(take[- ]home (?:assessment|test|assignment|project)|coding (?:challenge|assessment|test)|technical assessment|complete (?:the |an )?assessment|hackerrank|codility|karat\.io|online assessment|skills assessment)\b/i
const ADDITIONAL_INFORMATION = /\b(could you (?:please )?(?:send|provide|share|clarify)|please (?:send|provide|share|attach) (?:your |a )?(?:updated )?(?:resume|references|transcript|portfolio|writing sample)|need (?:some )?(?:additional|more) information|(?:a )?few (?:more )?questions (?:for|about) you|complete (?:the )?(?:application|form) (?:below|here))\b/i
const SCHEDULING = /\b(what(?:'s| is) your availability|please (?:book|schedule|pick) a time|calendly\.com|share your availability|find a time (?:that works|to (?:connect|chat|talk))|book (?:some )?time on (?:my|our) calendar)\b/i
const RECRUITER_INTEREST = /\b(reached out because|came across your (?:profile|resume|background)|impressed by your (?:background|experience)|would love to (?:connect|chat|learn more)|(?:great|strong) fit for (?:a|an|our) (?:role|opening|team)|excited about your (?:background|experience|profile))\b/i

export function classifyRecruiterResponse(text: string): ResponseClassification {
  if (REJECTION.test(text)) return 'rejection'
  if (OFFER.test(text)) return 'offer'
  if (INTERVIEW_REQUEST.test(text)) return 'interview_request'
  if (SCREEN_REQUEST.test(text)) return 'screen_request'
  if (ASSESSMENT.test(text)) return 'assessment'
  if (ADDITIONAL_INFORMATION.test(text)) return 'additional_information'
  if (SCHEDULING.test(text)) return 'scheduling'
  if (RECRUITER_INTEREST.test(text)) return 'recruiter_interest'
  return 'unknown'
}

export function classifyInboundEmail(text: string): InboundClassification {
  const semantic = classifyRecruiterResponse(text)
  if (semantic !== 'unknown') return semantic
  if (CONFIRMATION.test(text)) return 'confirmation_check'
  return 'unknown'
}

export function responsePriority(classification: ResponseClassification): number {
  switch (classification) {
    case 'offer': return 100
    case 'interview_request': return 95
    case 'screen_request': return 90
    case 'recruiter_interest': return 85
    case 'assessment': return 80
    case 'scheduling': return 78
    case 'additional_information': return 75
    case 'rejection': return 40
    case 'unknown': return 0
  }
}

export function applicationStatusForResponse(classification: ResponseClassification): ResponseDrivenApplicationStatus | null {
  switch (classification) {
    case 'rejection': return 'REJECTED'
    case 'offer': return 'OFFER'
    case 'screen_request':
    case 'interview_request': return 'INTERVIEW'
    case 'recruiter_interest':
    case 'assessment':
    case 'additional_information':
    case 'scheduling': return 'FOLLOWUP_DUE'
    case 'unknown': return null
  }
}

export function resolveApplicationStatusAfterResponse(
  currentStatus: string,
  classification: ResponseClassification,
): ResponseDrivenApplicationStatus | null {
  const proposed = applicationStatusForResponse(classification)
  if (!proposed) return null
  if (proposed === 'REJECTED' || proposed === 'OFFER') return proposed
  if (currentStatus === 'OFFER') return 'OFFER'
  if (currentStatus === 'INTERVIEW' && proposed === 'FOLLOWUP_DUE') return 'INTERVIEW'
  return proposed
}

export function isPositiveResponse(classification: ResponseClassification): boolean {
  return classification !== 'rejection' && classification !== 'unknown'
}
