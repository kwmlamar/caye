export function escalationCategoryLabel(
  category: 'gap' | 'policy' | 'knowledge' | 'sensitive'
): string {
  switch (category) {
    case 'gap': return "something Caye doesn't have the tools to do"
    case 'policy': return 'a call only the owner can make'
    case 'knowledge': return 'something outside what Caye knows about the business'
    case 'sensitive': return 'a sensitive or commercial matter'
  }
}

const TOOL_MARKER_PATTERN = /\s*\[tool_use:[^\]]*\]|\s*\[tool_result\]|\s*\[internal_only\]/g
export const INTERNAL_UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i

const INTERNAL_PROSE_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /\bForced escalation\s*—/i, label: 'forced-escalation stem' },
  { pattern: /\binbound classifier\s*—/i, label: 'classifier diagnostic' },
  { pattern: /\bCustomer message excerpt:/i, label: 'internal excerpt label' },
  { pattern: /\bCaye did not draft a substantive reply\b/i, label: 'internal handoff note' },
  { pattern: /\bOwner: review the thread\b/i, label: 'internal owner directive' },
  { pattern: /\bhybrid sentiment cascade\b/i, label: 'cascade diagnostic' },
  { pattern: /\[(?:[a-z][a-z0-9]*(?:_[a-z0-9]+)+|empty)\]/, label: 'internal event token' },
  { pattern: /\bNOTHING_TO_REPORT\b/, label: 'quiet-scan sentinel' },
  {
    pattern: /\b(?:availability_claim_unverified|quote_without_database_price|high_stakes_claim_without_verified_context|model_reported_uncertainty|owner_followup_requested)\b/,
    label: 'evidence-gate reason code',
  },
  { pattern: /\bwould have escalated:/i, label: 'routing-engine narration' },
  { pattern: /\bEscalation \([a-z_]+\):/i, label: 'raw escalation category prefix' },
]

export function mediaPlaceholder(messageType: string | null | undefined): string {
  switch ((messageType ?? '').toLowerCase()) {
    case 'image': return 'Photo'
    case 'video': return 'Video'
    case 'audio':
    case 'voice':
    case 'ptt': return 'Voice note'
    case 'document': return 'Document'
    case 'sticker': return 'Sticker'
    case 'location': return 'Location'
    case 'contacts':
    case 'contact': return 'Contact card'
    default: return 'Attachment'
  }
}

/**
 * Final boundary for normal operator-facing prose. Internal identifiers stay in
 * audit/evidence, but a raw UUID is never useful to a business operator and was
 * the exact shape leaked by the held-thread flow in production.
 */
export function detectInternalLeak(text: string): string | null {
  if (!text) return null
  const found: string[] = []
  if (/\[tool_use:|\[tool_result\]/.test(text)) found.push('raw tool marker')
  if (INTERNAL_UUID_PATTERN.test(text)) found.push('raw internal identifier')
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

export function detectToolNameLeak(text: string, toolNames: readonly string[]): string | null {
  if (!text) return null
  for (const name of toolNames) {
    if (new RegExp(`\\b${name}\\b`).test(text)) return name
  }
  return null
}

export function stripToolMarkers(text: string): string {
  return text.replace(TOOL_MARKER_PATTERN, '').trim()
}
