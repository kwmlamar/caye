/**
 * operator-learning/schema.ts
 *
 * Shared types + pure validation for the Operator Learning Router. No I/O —
 * unit-testable without Supabase or Anthropic, matching this codebase's
 * convention of keeping decision logic pure and pushing I/O to the edges
 * (business-fact-candidate-detection.ts, service-availability.ts).
 *
 * DESIGN NOTE: several fields here (explicitness/scope/risk/canonical_key
 * shape) are deliberately similar to the unmerged issue #121 branch
 * (learned_operating_knowledge / lib/operator-learning.ts) — that branch is
 * used here as a design reference only, per the current product decision.
 * This module does NOT create a new authoritative knowledge store: every
 * successful classification is routed into an EXISTING store
 * (business_facts, service_pricing_tiers, operator_allowlist,
 * service_availability_rules, service_date_overrides). This file only
 * defines the shape of the routing DECISION.
 */

export const CLASSIFIER_VERSION = 'operator-learning-router.v1'

export type Explicitness =
  | 'explicit_statement'
  | 'explicit_correction'
  | 'inferred_from_action'
  | 'ambiguous'

export type ScopeKind = 'standing' | 'date_scoped' | 'customer_scoped' | 'one_off' | 'ambiguous'

export type ScopeTarget = 'workspace' | 'service' | 'specific_date' | 'customer' | 'person' | 'unknown'

export interface Scope {
  kind: ScopeKind
  target: ScopeTarget
  /** Free-text service name as the operator said it, when target === 'service'. Resolved deterministically downstream via resolveServiceByName — never trusted as an id. */
  serviceName: string | null
  /** Required/resolved when target === 'specific_date'. 'YYYY-MM-DD'. */
  dateISO: string | null
}

export type RiskLevel = 'low' | 'consequential'

export type Destination =
  | 'business_fact'
  | 'pricing'
  | 'contact'
  | 'availability_recurring'
  | 'availability_date'
  | 'none'

export interface BusinessFactPayload {
  category: 'policy' | 'service_detail' | 'special_handling' | 'logistics'
  text: string
}

export interface PricingPayload {
  serviceName: string
  /** Tier name as the operator said it, or null when unnamed (e.g. "the shared tour is $110/person" naming the tour, not a tier). */
  tierName: string | null
  /** 'shared' | 'private' | etc — matches service_pricing_tiers.variant convention. Null when not stated. */
  variant: string | null
  priceAmount: number
  isFlat: boolean
}

export interface ContactPayload {
  name: string
  phone: string
  role: 'owner' | 'staff' | 'driver'
}

export interface AvailabilityRecurringPayload {
  serviceName: string
  /** 0=Sunday..6=Saturday, or null for every day. */
  weekday: number | null
  effect: 'unavailable' | 'departure_minimum'
  minParty: number | null
  note: string | null
}

export interface AvailabilityDatePayload {
  serviceName: string
  dateISO: string
  effect: 'unavailable' | 'departure_minimum' | 'variant_only'
  minParty: number | null
  restrictedVariant: string | null
  note: string | null
}

export interface ClassificationResult {
  /** False for anything that isn't reusable business knowledge at all — e.g. "tell Autumn I'll call her tomorrow". Short-circuits everything else. */
  learnable: boolean
  explicitness: Explicitness
  scope: Scope
  risk: RiskLevel
  destination: Destination
  /** Stable topic identity for supersession chaining. Required whenever learnable && destination !== 'none'. */
  canonicalKey: string | null
  confidence: number
  rationale: string

  businessFact: BusinessFactPayload | null
  pricing: PricingPayload | null
  contact: ContactPayload | null
  availabilityRecurring: AvailabilityRecurringPayload | null
  availabilityDate: AvailabilityDatePayload | null
}

const EXPLICITNESS_VALUES: Explicitness[] = [
  'explicit_statement',
  'explicit_correction',
  'inferred_from_action',
  'ambiguous',
]
const SCOPE_KIND_VALUES: ScopeKind[] = ['standing', 'date_scoped', 'customer_scoped', 'one_off', 'ambiguous']
const SCOPE_TARGET_VALUES: ScopeTarget[] = ['workspace', 'service', 'specific_date', 'customer', 'person', 'unknown']
const RISK_VALUES: RiskLevel[] = ['low', 'consequential']
const DESTINATION_VALUES: Destination[] = [
  'business_fact',
  'pricing',
  'contact',
  'availability_recurring',
  'availability_date',
  'none',
]
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function isOneOf<T extends string>(values: readonly T[], v: unknown): v is T {
  return typeof v === 'string' && (values as readonly string[]).includes(v)
}

/**
 * Schema validation for raw classifier JSON. Never throws — returns a typed
 * result or a rejection reason. Malformed/missing/out-of-range output is
 * ALWAYS rejected here; nothing downstream ever fabricates a default for a
 * missing structured field.
 */
export function validateClassification(raw: unknown): { ok: true; value: ClassificationResult } | { ok: false; reason: string } {
  if (typeof raw !== 'object' || raw === null) return { ok: false, reason: 'classifier output is not an object' }
  const r = raw as Record<string, unknown>

  if (typeof r.learnable !== 'boolean') return { ok: false, reason: 'learnable is not a boolean' }

  // A non-learnable result doesn't need the rest of the shape validated —
  // there is nothing downstream that will read it.
  if (r.learnable === false) {
    return {
      ok: true,
      value: {
        learnable: false,
        explicitness: isOneOf(EXPLICITNESS_VALUES, r.explicitness) ? r.explicitness : 'ambiguous',
        scope: { kind: 'ambiguous', target: 'unknown', serviceName: null, dateISO: null },
        risk: 'low',
        destination: 'none',
        canonicalKey: null,
        confidence: typeof r.confidence === 'number' ? clamp01(r.confidence) : 0,
        rationale: typeof r.rationale === 'string' ? r.rationale.slice(0, 500) : 'not reusable knowledge',
        businessFact: null,
        pricing: null,
        contact: null,
        availabilityRecurring: null,
        availabilityDate: null,
      },
    }
  }

  if (!isOneOf(EXPLICITNESS_VALUES, r.explicitness)) return { ok: false, reason: 'invalid explicitness' }
  if (!isOneOf(RISK_VALUES, r.risk)) return { ok: false, reason: 'invalid risk' }
  if (!isOneOf(DESTINATION_VALUES, r.destination)) return { ok: false, reason: 'invalid destination' }

  const rawScope = r.scope
  if (typeof rawScope !== 'object' || rawScope === null) return { ok: false, reason: 'scope is not an object' }
  const s = rawScope as Record<string, unknown>
  if (!isOneOf(SCOPE_KIND_VALUES, s.kind)) return { ok: false, reason: 'invalid scope.kind' }
  if (!isOneOf(SCOPE_TARGET_VALUES, s.target)) return { ok: false, reason: 'invalid scope.target' }
  const dateISO = typeof s.dateISO === 'string' && ISO_DATE.test(s.dateISO) ? s.dateISO : null
  if (s.target === 'specific_date' && !dateISO) {
    return { ok: false, reason: 'scope.target is specific_date but dateISO is missing/invalid' }
  }
  const scope: Scope = {
    kind: s.kind,
    target: s.target,
    serviceName: typeof s.serviceName === 'string' && s.serviceName.trim() ? s.serviceName.trim() : null,
    dateISO,
  }

  const canonicalKey = typeof r.canonicalKey === 'string' && r.canonicalKey.trim() ? r.canonicalKey.trim().slice(0, 160) : null
  if (r.destination !== 'none' && !canonicalKey) {
    return { ok: false, reason: 'canonicalKey is required for a learnable, routable classification' }
  }

  const confidence = typeof r.confidence === 'number' ? clamp01(r.confidence) : 0
  const rationale = typeof r.rationale === 'string' ? r.rationale.slice(0, 500) : ''

  let businessFact: BusinessFactPayload | null = null
  if (r.destination === 'business_fact') {
    const bf = r.businessFact as Record<string, unknown> | undefined
    if (!bf || typeof bf.text !== 'string' || bf.text.trim().length < 5) {
      return { ok: false, reason: 'destination is business_fact but businessFact.text is missing/too short' }
    }
    const categories = ['policy', 'service_detail', 'special_handling', 'logistics']
    if (!isOneOf(categories, bf.category)) return { ok: false, reason: 'invalid businessFact.category' }
    businessFact = { category: bf.category as BusinessFactPayload['category'], text: bf.text.trim().slice(0, 800) }
  }

  let pricing: PricingPayload | null = null
  if (r.destination === 'pricing') {
    const p = r.pricing as Record<string, unknown> | undefined
    if (!p || typeof p.serviceName !== 'string' || !p.serviceName.trim()) {
      return { ok: false, reason: 'destination is pricing but pricing.serviceName is missing' }
    }
    if (typeof p.priceAmount !== 'number' || !Number.isFinite(p.priceAmount) || p.priceAmount < 0) {
      return { ok: false, reason: 'invalid pricing.priceAmount' }
    }
    if (typeof p.isFlat !== 'boolean') return { ok: false, reason: 'invalid pricing.isFlat' }
    pricing = {
      serviceName: p.serviceName.trim(),
      tierName: typeof p.tierName === 'string' && p.tierName.trim() ? p.tierName.trim() : null,
      variant: typeof p.variant === 'string' && p.variant.trim() ? p.variant.trim().toLowerCase() : null,
      priceAmount: p.priceAmount,
      isFlat: p.isFlat,
    }
  }

  let contact: ContactPayload | null = null
  if (r.destination === 'contact') {
    const c = r.contact as Record<string, unknown> | undefined
    const roles = ['owner', 'staff', 'driver']
    if (!c || typeof c.name !== 'string' || !c.name.trim()) return { ok: false, reason: 'contact.name is missing' }
    if (typeof c.phone !== 'string' || !c.phone.trim()) return { ok: false, reason: 'contact.phone is missing' }
    if (!isOneOf(roles, c.role)) return { ok: false, reason: 'invalid contact.role' }
    contact = { name: c.name.trim(), phone: c.phone.trim(), role: c.role as ContactPayload['role'] }
  }

  let availabilityRecurring: AvailabilityRecurringPayload | null = null
  if (r.destination === 'availability_recurring') {
    const a = r.availabilityRecurring as Record<string, unknown> | undefined
    if (!a || typeof a.serviceName !== 'string' || !a.serviceName.trim()) {
      return { ok: false, reason: 'availabilityRecurring.serviceName is missing' }
    }
    const effects = ['unavailable', 'departure_minimum']
    if (!isOneOf(effects, a.effect)) return { ok: false, reason: 'invalid availabilityRecurring.effect' }
    const weekday = typeof a.weekday === 'number' && a.weekday >= 0 && a.weekday <= 6 ? a.weekday : null
    const minParty = typeof a.minParty === 'number' && a.minParty > 0 ? a.minParty : null
    if (a.effect === 'departure_minimum' && minParty === null) {
      return { ok: false, reason: 'availabilityRecurring.effect is departure_minimum but minParty is missing' }
    }
    availabilityRecurring = {
      serviceName: a.serviceName.trim(),
      weekday,
      effect: a.effect as AvailabilityRecurringPayload['effect'],
      minParty,
      note: typeof a.note === 'string' ? a.note.trim().slice(0, 300) : null,
    }
  }

  // Parsed whenever a well-formed availabilityDate payload is PRESENT, not
  // only when destination === 'availability_date'. This is what lets
  // route-decision reroute a date-scoped correction the model reached for
  // business_fact on (e.g. "we only have private available that day") to
  // the date-scoped destination instead — the reroute needs the structured
  // payload even though it wasn't the model's primary destination guess.
  // Required (rejects the whole classification on failure) only when it IS
  // the primary destination; opportunistic (silently absent) otherwise.
  let availabilityDate: AvailabilityDatePayload | null = null
  if (r.availabilityDate !== undefined && r.availabilityDate !== null) {
    const parsed = parseAvailabilityDatePayload(r.availabilityDate)
    if (r.destination === 'availability_date' && !parsed) {
      return { ok: false, reason: 'destination is availability_date but availabilityDate payload is invalid/incomplete' }
    }
    availabilityDate = parsed
  } else if (r.destination === 'availability_date') {
    return { ok: false, reason: 'destination is availability_date but availabilityDate payload is missing' }
  }

  return {
    ok: true,
    value: {
      learnable: true,
      explicitness: r.explicitness,
      scope,
      risk: r.risk,
      destination: r.destination,
      canonicalKey,
      confidence,
      rationale,
      businessFact,
      pricing,
      contact,
      availabilityRecurring,
      availabilityDate,
    },
  }
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}

/** Returns the parsed payload when fully well-formed, otherwise null (never throws). */
function parseAvailabilityDatePayload(raw: unknown): AvailabilityDatePayload | null {
  if (typeof raw !== 'object' || raw === null) return null
  const a = raw as Record<string, unknown>
  if (typeof a.serviceName !== 'string' || !a.serviceName.trim()) return null
  if (typeof a.dateISO !== 'string' || !ISO_DATE.test(a.dateISO)) return null
  const effects = ['unavailable', 'departure_minimum', 'variant_only']
  if (!isOneOf(effects, a.effect)) return null
  const minParty = typeof a.minParty === 'number' && a.minParty > 0 ? a.minParty : null
  const restrictedVariant =
    typeof a.restrictedVariant === 'string' && a.restrictedVariant.trim() ? a.restrictedVariant.trim().toLowerCase() : null
  if (a.effect === 'departure_minimum' && minParty === null) return null
  if (a.effect === 'variant_only' && !restrictedVariant) return null
  return {
    serviceName: a.serviceName.trim(),
    dateISO: a.dateISO,
    effect: a.effect as AvailabilityDatePayload['effect'],
    minParty,
    restrictedVariant,
    note: typeof a.note === 'string' ? a.note.trim().slice(0, 300) : null,
  }
}
