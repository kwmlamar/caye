/**
 * Job-search response loop — classify an inbound recruiter/ATS email into
 * the canonical response taxonomy the funnel and next-action logic key off
 * of. This is a pure text classifier (no DB access) so it's cheap to unit
 * test exhaustively; lib/job-search/email-correlation.ts is the only caller
 * and owns writing the result to job_search_followups / job_search_applications.
 *
 * Order matters: patterns are checked most-specific-and-highest-signal
 * first. A rejection email frequently contains the word "interview"
 * ("...will not be moving forward in our interview process...") so
 * REJECTION and OFFER are checked before anything interview-shaped, and a
 * fully-generic scheduling nudge is checked last among the "something is
 * happening" buckets so a clearer signal (interview/screen/assessment)
 * always wins.
 *
 * `confirmation_check` (an autoresponder "we received your application")
 * is intentionally NOT part of this taxonomy: it is not a human response
 * and must never advance the funnel or set first_response_at. It keeps its
 * own pre-existing followup_type and is classified separately, before this
 * function runs — see classifyInboundEmail() below, the actual entry point
 * email-correlation.ts calls.
 */

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

const CONFIRMATION =
  /\b(application (?:was |has been )?(?:received|submitted)|thanks? for applying|application confirmation|we('| ha)ve received your application)\b/i

const REJECTION =
  /\b(unfortunately|regret to inform|will not be moving forward|decided not to move forward|will not be proceeding|not moving forward with your (?:application|candidacy)|not selected for (?:this|the) (?:role|position)|pursue other candidates|other candidates whose (?:experience|background|qualifications)|position has been filled|no longer (?:considering|accepting) your application|move forward with other candidates|not (?:be )?(?:a fit|the right fit) (?:for this role )?at this time|will not be extending an offer|wish you (?:the )?(?:best|luck) (?:in|with) your (?:job |career )?search|closing (?:out|this) (?:your |the )?application)\b/i

const OFFER =
  /\b(pleased to (?:offer|extend)|(?:extend|extending) (?:you )?an offer|offer letter|excited to offer you the (?:role|position)|welcome to the team|formal offer|verbal offer)\b/i

const INTERVIEW_REQUEST =
  /\b(schedule (?:an |your )?interview|would like to (?:invite you to |set up an )?interview|interview (?:availability|invite|invitation|request)|panel interview|onsite interview|virtual interview|final round|move (?:you )?(?:forward )?to (?:the )?interview stage|next step is an interview)\b/i

const SCREEN_REQUEST =
  /\b(phone screen|recruiter screen|intro(?:ductory)? call|initial (?:call|conversation)|quick call to (?:discuss|chat|connect)|screening call|(?:connect|chat) (?:with you )?(?:for|over) (?:a )?(?:quick )?call)\b/i

const ASSESSMENT =
  /\b(take[- ]home (?:assessment|test|assignment|project)|coding (?:challenge|assessment|test)|technical assessment|complete (?:the |an )?assessment|hackerrank|codility|karat\.io|online assessment|skills assessment)\b/i

const SCHEDULING =
  /\b(what(?:'s| is) your availability|please (?:book|schedule|pick) a time|calendly\.com|share your availability|find a time (?:that works|to (?:connect|chat|talk))|book (?:some )?time on (?:my|our) calendar)\b/i

const ADDITIONAL_INFORMATION =
  /\b(could you (?:please )?(?:send|provide|share|clarify)|please (?:send|provide|share|attach) (?:your |a )?(?:updated )?(?:resume|references|transcript|portfolio|writing sample)|need (?:some )?(?:additional|more) information|(?:a )?few (?:more )?questions (?:for|about) you|complete (?:the )?(?:application|form) (?:below|here))\b/i

const RECRUITER_INTEREST =
  /\b(reached out because|came across your (?:profile|resume|background)|impressed by your (?:background|experience)|would love to (?:connect|chat|learn more)|exploring (?:opportunities|roles) (?:with|at)|(?:great|strong) fit for (?:a|an|our) (?:role|opening|team)|excited about your (?:background|experience|profile))\b/i

/** Classify raw recruiter/ATS email text (subject + body) into the 9-state response taxonomy. */
export function classifyRecruiterResponse(text: string): ResponseClassification {
  if (REJECTION.test(text)) return 'rejection'
  if (OFFER.test(text)) return 'offer'
  if (INTERVIEW_REQUEST.test(text)) return 'interview_request'
  if (SCREEN_REQUEST.test(text)) return 'screen_request'
  if (ASSESSMENT.test(text)) return 'assessment'
  if (SCHEDULING.test(text)) return 'scheduling'
  if (ADDITIONAL_INFORMATION.test(text)) return 'additional_information'
  if (RECRUITER_INTEREST.test(text)) return 'recruiter_interest'
  return 'unknown'
}

/** Entry point: separates the autoresponder-ack case from real classification. */
export function classifyInboundEmail(text: string): InboundClassification {
  if (CONFIRMATION.test(text)) return 'confirmation_check'
  return classifyRecruiterResponse(text)
}

/** Categories where a routine drafted reply is ever permitted. Everything else must escalate to the founder. */
export const LOW_RISK_REPLY_CATEGORIES: ReadonlySet<ResponseClassification> = new Set([
  'recruiter_interest',
  'screen_request',
  'scheduling',
  'additional_information',
])

/**
 * Categories that must never be auto-drafted or auto-sent, even under a
 * standing authorization: compensation, legal/work-authorization ambiguity,
 * offers, and anything else consequential. Kept as an explicit denylist
 * (checked first, wins over the allowlist above) so a new category added to
 * ResponseClassification fails closed into escalation rather than silently
 * becoming draftable.
 */
export const FOUNDER_ONLY_CATEGORIES: ReadonlySet<ResponseClassification> = new Set([
  'offer',
  'rejection',
  'interview_request',
  'unknown',
])

export function isRoutineReplyCategory(category: ResponseClassification): boolean {
  if (FOUNDER_ONLY_CATEGORIES.has(category)) return false
  return LOW_RISK_REPLY_CATEGORIES.has(category)
}
