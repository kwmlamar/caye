/**
 * Pure guard that catches Caye's internal machinery leaking into text an
 * operator actually reads. Sibling of policy-figure-guard.ts and
 * caye-identity-guard.ts — same reasoning: the structural fix is upstream,
 * and a backstop in code is what keeps it fixed.
 */

const TOOL_MARKER_PATTERN = /\s*\[tool_use:[^\]]*\]|\s*\[tool_result\]/g

const INTERNAL_PROSE_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /\bForced escalation\s*—/i, label: 'forced-escalation stem' },
  { pattern: /\binbound classifier\s*—/i, label: 'classifier diagnostic' },
  { pattern: /\bCustomer message excerpt:/i, label: 'internal excerpt label' },
  {
    pattern: /\bCaye did not draft a substantive reply\b/i,
    label: 'internal handoff note',
  },
  { pattern: /\bOwner: review the thread\b/i, label: 'internal owner directive' },
  { pattern: /\bhybrid sentiment cascade\b/i, label: 'cascade diagnostic' },
  {
    pattern: /\[(?:[a-z][a-z0-9]*(?:_[a-z0-9]+)+|empty)\]/,
    label: 'internal event token',
  },
  { pattern: /\bNOTHING_TO_REPORT\b/, label: 'quiet-scan sentinel' },
]

/**
 * Product-level ban on redirecting an owner/operator to an external mailbox
 * to review a draft. Owner drafting lives in the active Caye conversation.
 *
 * Catches both instructions ("check Gmail Drafts") and offers ("put it in
 * your Zoho Drafts?") while leaving ordinary provider facts such as "Zoho is
 * connected" alone.
 */
export function detectMailboxDraftRedirect(text: string): string | null {
  if (!text) return null

  const mailbox = '(?:gmail|zoho(?: mail)?|e-?mail|mailbox|inbox)'
  const drafts = 'drafts?(?: folder)?'
  const imperative = new RegExp(
    `\\b(?:open|check|look(?: for| in)?|go(?: to| into)?|find|review)\\b[\\s\\S]{0,60}\\b${mailbox}\\b[\\s\\S]{0,35}\\b${drafts}\\b`,
    'i'
  )
  const offer = new RegExp(
    `\\b(?:put|save|file|create|push|leave)\\b[\\s\\S]{0,70}\\b${mailbox}\\b[\\s\\S]{0,35}\\b${drafts}\\b`,
    'i'
  )
  const destination = new RegExp(
    `\\b(?:in|into|to) (?:your )?(?:${mailbox} )?${drafts}\\b`,
    'i'
  )

  if (imperative.test(text)) return 'directs operator to external mailbox drafts'
  if (offer.test(text)) return 'offers external mailbox draft filing'
  if (destination.test(text) && /\b(?:draft|file|save|put|open|check|review)\b/i.test(text)) {
    return 'routes operator draft to external mailbox'
  }
  return null
}

export function mediaPlaceholder(messageType: string | null | undefined): string {
  switch ((messageType ?? '').toLowerCase()) {
    case 'image':
      return 'Photo'
    case 'video':
      return 'Video'
    case 'audio':
    case 'voice':
    case 'ptt':
      return 'Voice note'
    case 'document':
      return 'Document'
    case 'sticker':
      return 'Sticker'
    case 'location':
      return 'Location'
    case 'contacts':
    case 'contact':
      return 'Contact card'
    default:
      return 'Attachment'
  }
}

export function detectInternalLeak(text: string): string | null {
  if (!text) return null

  const found: string[] = []
  if (/\[tool_use:|\[tool_result\]/.test(text)) found.push('raw tool marker')
  for (const { pattern, label } of INTERNAL_PROSE_PATTERNS) {
    if (pattern.test(text)) found.push(label)
  }

  return found.length > 0 ? `contains ${found.join(', ')}` : null
}

export function founderBriefingLeak(text: string): string | null {
  const base = detectInternalLeak(text)
  if (base) return base

  if (/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/.test(text)) return 'contains internal identifier (snake_case)'
  if (/\bself-rated confidence\b/i.test(text)) return 'contains confidence-model language'
  if (/\bLayer\s*\d+\b/i.test(text)) return 'contains internal spec reference'

  return null
}

/**
 * Does `text` bare-name one of Caye's own tools to the operator?
 *
 * CAY-11 also treats external-mailbox draft routing as forbidden operator
 * output. The draft_in_inbox tool is retired and no longer appears in the
 * live registry, so stale prompt prose must be caught independently.
 */
export function detectToolNameLeak(text: string, toolNames: readonly string[]): string | null {
  if (!text) return null
  for (const name of toolNames) {
    if (new RegExp(`\\b${name}\\b`).test(text)) return name
  }
  return detectMailboxDraftRedirect(text)
}

export function stripToolMarkers(text: string): string {
  return text.replace(TOOL_MARKER_PATTERN, '').trim()
}
