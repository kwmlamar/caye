export type LearningAuthority =
  | 'owner_correction'
  | 'owner_instruction'
  | 'configured_business_source'
  | 'direct_business_communication'
  | 'repeated_operational_observation'
  | 'inferred_pattern'
  | 'speculative_extraction'

export type MemoryKind =
  | 'durable_fact'
  | 'temporary_state'
  | 'customer_state'
  | 'preference'
  | 'procedure'
  | 'policy'
  | 'service_info'
  | 'operational_pattern'
  | 'speculative_observation'

export type CustomerUseState = 'customer_safe' | 'requires_confirmation' | 'internal_only'

export interface LearningScope {
  target: 'workspace' | 'service' | 'customer' | 'specific_date' | 'unknown'
  serviceName?: string | null
  customerId?: string | null
  dateISO?: string | null
}

export interface ExtractedLearningCandidate {
  kind: MemoryKind
  durable: boolean
  category: 'policy' | 'service_detail' | 'special_handling' | 'logistics'
  propertyKey: string
  valueText: string
  scope: LearningScope
  confidence: number
  consequential: boolean
  customerUseState: CustomerUseState
  rationale: string
}

const AUTHORITY_RANK: Record<LearningAuthority, number> = {
  owner_correction: 700,
  owner_instruction: 600,
  configured_business_source: 500,
  direct_business_communication: 400,
  repeated_operational_observation: 300,
  inferred_pattern: 200,
  speculative_extraction: 100,
}

export function authorityRank(authority: LearningAuthority): number { return AUTHORITY_RANK[authority] }

export function canSupersede(
  incoming: { authority: LearningAuthority; occurredAt: string },
  current: { authority: LearningAuthority; occurredAt: string }
): boolean {
  const incomingRank = authorityRank(incoming.authority)
  const currentRank = authorityRank(current.authority)
  if (incomingRank !== currentRank) return incomingRank > currentRank
  return new Date(incoming.occurredAt).getTime() >= new Date(current.occurredAt).getTime()
}

function tokens(value: string): string[] {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean)
}

// Deliberately narrow — see canonical-key.migration.test.ts. Guessing outside
// this vocabulary is what caused the incident that test guards against.
const KNOWN_ALIAS_PATTERNS: Array<[RegExp, string]> = [
  [/meeting[_ ]?point|pick[_ -]?up[_ ]?(?:location|point)?|pickup[_ ]?(?:location|point)?/, 'meeting_point'],
  [/payment[_ ]?method/, 'payment_method'],
  [/cancel(?:lation)?[_ ]?policy/, 'cancellation_policy'],
  [/refund[_ ]?policy/, 'refund_policy'],
  [/invoice.*(?:upload|submit)|(?:upload|submit).*invoice/, 'invoice_submission_process'],
  [/proposal.*sign|signature.*proposal/, 'proposal_signature_workflow'],
]

function matchKnownAlias(propertyTokens: string[], valueText: string): string | null {
  const joined = propertyTokens.join('_')
  const context = `${joined} ${valueText}`.toLowerCase()
  for (const [pattern, alias] of KNOWN_ALIAS_PATTERNS) {
    if (pattern.test(context)) return alias
  }
  return null
}

function propertyAlias(propertyTokens: string[], valueText: string): string {
  return matchKnownAlias(propertyTokens, valueText) ?? (propertyTokens.join('_') || 'unknown_property')
}

/** Canonical identity names the business PROPERTY, never its current value. */
export function canonicalPropertyKey(args: {
  suggestedProperty: string
  valueText: string
  scope: LearningScope
  resolvedServiceId?: string | null
}): string {
  const valueTokens = new Set(tokens(args.valueText))
  const suggested = tokens(args.suggestedProperty)
  const withoutValue = suggested.filter((token) => !valueTokens.has(token))
  // Try the vocabulary against the UNSTRIPPED suggested key first. A known
  // alias matching here is the vocabulary doing its job, not a guess — and
  // stripping value words can destroy adjacency the alias regex depends on
  // when a word is legitimately part of both the property name and the value
  // text (e.g. "payment" in both "payment-method-online" and "Online payment
  // only."). Only fall back to the value-stripped form when nothing in the
  // fixed vocabulary recognizes the property as suggested.
  const property = matchKnownAlias(suggested, args.valueText) ?? propertyAlias(withoutValue.length ? withoutValue : suggested, args.valueText)
  if (args.scope.target === 'service') {
    const serviceScope = args.resolvedServiceId ? args.resolvedServiceId.toLowerCase() : tokens(args.scope.serviceName ?? 'unknown').join('_') || 'unknown'
    return `service.${serviceScope}.${property}`
  }
  if (args.scope.target === 'customer') {
    const customer = tokens(args.scope.customerId ?? 'specific').join('_') || 'specific'
    return `customer.${customer}.${property}`
  }
  if (args.scope.target === 'specific_date') return `date.${args.scope.dateISO ?? 'unknown'}.${property}`
  return `workspace.${property}`
}

export function propertyIdentityTail(canonicalKey: string): string {
  const parts = canonicalKey.split('.').filter(Boolean)
  return parts[parts.length - 1] ?? canonicalKey
}

/** Same property+value evidence merges across independent observations; workspace remains a hard boundary. */
export function candidateFingerprint(args: { workspaceId: string; canonicalKey: string; valueText: string }): string {
  return [args.workspaceId, args.canonicalKey, normalizedCandidateValue(args.valueText)].join('|')
}

export function normalizedCandidateValue(valueText: string): string { return tokens(valueText).join(' ') }

export function promotionPolicy(args: {
  authority: LearningAuthority
  confidence: number
  occurrenceCount: number
  consequential: boolean
  customerUseState: CustomerUseState
}): { promote: boolean; reason: string } {
  if (args.consequential && args.customerUseState !== 'customer_safe') return { promote: false, reason: 'consequential knowledge is not grounded for customer use' }
  if (authorityRank(args.authority) >= authorityRank('configured_business_source') && args.confidence >= 0.8) return { promote: true, reason: 'authoritative explicit source' }
  if (args.authority === 'direct_business_communication') return { promote: false, reason: 'direct communication is evidence, not standing business policy' }
  if (args.authority === 'repeated_operational_observation' && args.occurrenceCount >= 3 && args.confidence >= 0.8) return { promote: true, reason: 'repeated non-consequential operational pattern' }
  return { promote: false, reason: 'requires more authoritative or repeated evidence' }
}
