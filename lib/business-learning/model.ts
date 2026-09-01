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

export type CustomerUseState =
  | 'customer_safe'
  | 'requires_confirmation'
  | 'internal_only'

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

export function authorityRank(authority: LearningAuthority): number {
  return AUTHORITY_RANK[authority]
}

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
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
}

function propertyAlias(propertyTokens: string[], valueText: string): string {
  const joined = propertyTokens.join('_')
  const context = `${joined} ${valueText}`.toLowerCase()
  if (/meeting[_ ]?point|pick[_ -]?up[_ ]?(?:location|point)?|pickup[_ ]?(?:location|point)?/.test(context)) {
    return 'meeting_point'
  }
  if (/payment[_ ]?method/.test(context)) return 'payment_method'
  if (/cancel(?:lation)?[_ ]?policy/.test(context)) return 'cancellation_policy'
  if (/refund[_ ]?policy/.test(context)) return 'refund_policy'
  if (/invoice.*(?:upload|submit)|(?:upload|submit).*invoice/.test(context)) return 'invoice_submission_process'
  if (/proposal.*sign|signature.*proposal/.test(context)) return 'proposal_signature_workflow'
  return joined || 'unknown_property'
}

/**
 * Canonical identity names the BUSINESS PROPERTY, never its current value.
 *
 * The extractor supplies a semantic property label, but this function is the
 * deterministic boundary that prevents value words from becoming identity.
 * Tokens that occur in the extracted value are removed from the proposed key,
 * then known property aliases collapse wording variants such as pickup point,
 * meeting point, and tram-stop pickup to `meeting_point`.
 */
export function canonicalPropertyKey(args: {
  suggestedProperty: string
  valueText: string
  scope: LearningScope
  resolvedServiceId?: string | null
}): string {
  const valueTokens = new Set(tokens(args.valueText))
  const suggested = tokens(args.suggestedProperty)
  const withoutValue = suggested.filter((token) => !valueTokens.has(token))
  const property = propertyAlias(withoutValue.length ? withoutValue : suggested, args.valueText)

  if (args.scope.target === 'service') {
    const serviceScope = args.resolvedServiceId
      ? args.resolvedServiceId.toLowerCase()
      : tokens(args.scope.serviceName ?? 'unknown').join('_') || 'unknown'
    return `service.${serviceScope}.${property}`
  }
  if (args.scope.target === 'customer') {
    const customer = tokens(args.scope.customerId ?? 'specific').join('_') || 'specific'
    return `customer.${customer}.${property}`
  }
  if (args.scope.target === 'specific_date') {
    return `date.${args.scope.dateISO ?? 'unknown'}.${property}`
  }
  return `workspace.${property}`
}

export function propertyIdentityTail(canonicalKey: string): string {
  const parts = canonicalKey.split('.').filter(Boolean)
  return parts[parts.length - 1] ?? canonicalKey
}

export function candidateFingerprint(args: {
  workspaceId: string
  observationFingerprint: string
  canonicalKey: string
  valueText: string
}): string {
  const normalizedValue = tokens(args.valueText).join(' ')
  return [args.workspaceId, args.observationFingerprint, args.canonicalKey, normalizedValue].join('|')
}

export function normalizedCandidateValue(valueText: string): string {
  return tokens(valueText).join(' ')
}

export function promotionPolicy(args: {
  authority: LearningAuthority
  confidence: number
  occurrenceCount: number
  consequential: boolean
  customerUseState: CustomerUseState
}): { promote: boolean; reason: string } {
  if (args.consequential && args.customerUseState !== 'customer_safe') {
    return { promote: false, reason: 'consequential knowledge is not grounded for customer use' }
  }
  if (authorityRank(args.authority) >= authorityRank('configured_business_source') && args.confidence >= 0.8) {
    return { promote: true, reason: 'authoritative explicit source' }
  }
  if (args.authority === 'direct_business_communication') {
    return { promote: false, reason: 'direct communication is evidence, not standing business policy' }
  }
  if (args.authority === 'repeated_operational_observation' && args.occurrenceCount >= 3 && args.confidence >= 0.8) {
    return { promote: true, reason: 'repeated non-consequential operational pattern' }
  }
  return { promote: false, reason: 'requires more authoritative or repeated evidence' }
}
