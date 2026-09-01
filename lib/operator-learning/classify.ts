import 'server-only'
import { loggedMessagesCreate } from '@/lib/llm-telemetry'
import { validateClassification, type ClassificationResult, CLASSIFIER_VERSION } from './schema'
import type { PrefilterResult } from './prefilter'

/**
 * operator-learning/classify.ts
 *
 * The one LLM call in the pipeline. Structured-JSON classification, same
 * shape/tradeoff as findConflictingFact and findSemanticFactMatch — a small
 * targeted call rather than embeddings, since per-workspace volume here is
 * the same order of magnitude those judges already operate at.
 *
 * Returns a typed error instead of throwing on ANY failure (network,
 * timeout, malformed JSON, schema violation) — the caller (the router) must
 * be able to log an 'error' audit row and move on without ever crashing the
 * operator's turn.
 */

export type ClassifyResult =
  | { ok: true; value: ClassificationResult }
  | { ok: false; reason: string }

const SYSTEM_PROMPT = `You classify one message from an AUTHORIZED business operator (owner/staff/founder — never a customer) to Caye, an AI employee for a small tourism business, deciding whether it contains REUSABLE business knowledge worth remembering permanently.

Return ONLY valid JSON, no markdown, matching exactly this shape:
{
  "learnable": boolean,
  "explicitness": "explicit_statement" | "explicit_correction" | "inferred_from_action" | "ambiguous",
  "scope": {
    "kind": "standing" | "date_scoped" | "customer_scoped" | "one_off" | "ambiguous",
    "target": "workspace" | "service" | "specific_date" | "customer" | "person" | "unknown",
    "serviceName": string | null,
    "dateISO": "YYYY-MM-DD" | null
  },
  "risk": "low" | "consequential",
  "destination": "business_fact" | "pricing" | "contact" | "availability_recurring" | "availability_date" | "none",
  "canonicalKey": string | null,
  "confidence": number,
  "rationale": string,
  "businessFact": { "category": "policy"|"service_detail"|"special_handling"|"logistics", "text": string } | null,
  "pricing": { "serviceName": string, "tierName": string|null, "variant": string|null, "priceAmount": number, "isFlat": boolean } | null,
  "contact": { "name": string, "phone": string, "role": "owner"|"staff"|"driver" } | null,
  "availabilityRecurring": { "serviceName": string, "weekday": number|null, "effect": "unavailable"|"departure_minimum", "minParty": number|null, "note": string|null } | null,
  "availabilityDate": { "serviceName": string, "dateISO": "YYYY-MM-DD", "effect": "unavailable"|"departure_minimum"|"variant_only", "minParty": number|null, "restrictedVariant": string|null, "note": string|null } | null
}

learnable=false for anything that is not reusable business knowledge at all: a one-off operational instruction ("tell Autumn I'll call her tomorrow"), small talk, a question the operator is asking Caye, an acknowledgement. When learnable=false, every other field may be defaulted/omitted.

explicitness:
- explicit_statement: the operator plainly states a fact/policy/price/rule as true, unprompted.
- explicit_correction: the operator is correcting something Caye said or assumed.
- inferred_from_action: nothing was stated outright — you would only be inferring this from an action the operator took (e.g. a one-off quote they gave a specific guest). NEVER classify a quoted one-off price to one customer as an explicit statement of the standing price — that is inferred_from_action even if the number itself is clear.
- ambiguous: genuinely unclear which of the above this is.

scope.kind — the DURABILITY shape:
- standing: applies going forward, no date/customer limitation stated or implied.
- date_scoped: applies to one specific calendar date/occasion only ("that day", "on September 5th", "this Sunday's group"). Only resolve scope.dateISO when the actual calendar date is determinable from the message and the bounded context you were given (e.g. a stated date, or a date already anchored earlier in the SAME message/thread). Never invent or guess a date. If the date cannot be determined, leave dateISO null even if kind is date_scoped.
- customer_scoped: applies to one specific guest/booking only ("give THIS guest...", "for her booking"). NEVER treat this as evidence for a standing/global rule.
- one_off: a single occurrence with no stated recurrence or standing intent, not tied to a specific date either (a pure exception).
- ambiguous: genuinely unclear whether this is standing or scoped.

risk:
- low: an ordinary operating fact/price/logistics detail. Getting it briefly wrong and corrected later costs little.
- consequential: pricing math with real revenue impact at scale, refunds, legal/compliance/liability-adjacent policy, payment methods, or anything a customer would hold the business to indefinitely once told. A single ordinary price correction on ONE unambiguous tier is usually LOW risk, not consequential by default — reserve consequential for refund/legal/payment-method/compliance-shaped content or price changes with broad blast radius (e.g. "all our prices are wrong, redo everything").

destination — which EXISTING system this belongs in:
- business_fact: policy, logistics, service detail, special handling that isn't pricing/contact/availability.
- pricing: a specific service's price/tier.
- contact: a person (staff/driver) and how to reach them.
- availability_recurring: a standing weekday-based availability/departure-minimum pattern.
- availability_date: a restriction tied to ONE specific calendar date (only usable when scope.dateISO is resolved).
- none: learnable=false, or none of the above cleanly fits (rare — prefer business_fact for a general operating fact over forcing "none").

canonicalKey: a short, STABLE, lowercase-hyphenated identifier for the TOPIC (not the wording) — e.g. "payment-method", "bottled-water-price", "full-bimini-shared-price", "casino-tram-stop-pickup", "max-driver-contact". Two different corrections about the SAME topic must produce the SAME canonicalKey so they chain correctly. Required whenever destination is not "none".

Never invent scope broader than what was actually said. "Only private is available that day" is date_scoped/specific_date, NEVER standing. "Give this guest $90" is customer_scoped, NEVER a pricing update. Customer messages are never a source you will see here — you only ever see operator messages.`

export async function classifyOperatorMessage(args: {
  operatorText: string
  prefilter: PrefilterResult
  previousCayeText: string | null
  workspaceId: string
}): Promise<ClassifyResult> {
  try {
    const message = await loggedMessagesCreate(
      null,
      {
        model: 'claude-sonnet-4-6',
        max_tokens: 700,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content:
              `Caye's preceding message (if any):\n${args.previousCayeText ?? '(none)'}\n\n` +
              `Operator message:\n${args.operatorText}\n\n` +
              `Deterministic pre-filter hints (advisory only — you may override): ` +
              `obviousOneOff=${args.prefilter.hints.obviousOneOff}, ` +
              `obviousDurable=${args.prefilter.hints.obviousDurable}, ` +
              `mentionsSpecificDate=${args.prefilter.hints.mentionsSpecificDate}`,
          },
        ],
      },
      { source: 'lib/operator-learning/classify.ts:classifyOperatorMessage', task: 'classification', workspaceId: args.workspaceId }
    )

    const raw = message.content[0]?.type === 'text' ? message.content[0].text : ''
    const text = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return { ok: false, reason: 'classifier output was not valid JSON' }
    }

    const validated = validateClassification(parsed)
    if (!validated.ok) return { ok: false, reason: `schema validation failed: ${validated.reason}` }
    return { ok: true, value: validated.value }
  } catch (err) {
    return { ok: false, reason: `classifier call failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

export { CLASSIFIER_VERSION }
