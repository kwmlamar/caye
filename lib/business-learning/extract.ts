import 'server-only'
import { loggedMessagesCreate } from '@/lib/llm-telemetry'
import type { ExtractedLearningCandidate, LearningAuthority } from './model'

export interface ExtractLearningInput {
  workspaceId: string
  content: string
  sourceKind: string
  sourceChannel: string | null
  authority: LearningAuthority
  sourceMetadata: Record<string, unknown>
}

export type ExtractionResult =
  | { ok: true; candidates: ExtractedLearningCandidate[] }
  | { ok: false; reason: string }

const SYSTEM = `You extract durable business-learning candidates from ONE legitimate small-business activity observation.

Do not maximize memories. Most transactional details are NOT durable memory.

Return ONLY JSON:
{"candidates":[{
  "kind":"durable_fact"|"temporary_state"|"customer_state"|"preference"|"procedure"|"policy"|"service_info"|"operational_pattern"|"speculative_observation",
  "durable":boolean,
  "category":"policy"|"service_detail"|"special_handling"|"logistics",
  "propertyKey":string,
  "valueText":string,
  "scope":{"target":"workspace"|"service"|"customer"|"specific_date"|"unknown","serviceName":string|null,"customerId":string|null,"dateISO":string|null},
  "confidence":number,
  "consequential":boolean,
  "customerUseState":"customer_safe"|"requires_confirmation"|"internal_only",
  "rationale":string
}]}

Rules:
- propertyKey names the PROPERTY, never its value. Example: propertyKey="meeting_point", valueText="Casino Tram Stop". Never emit "casino_tram_stop_pickup" or another value-bearing identity.
- A customer request, invoice number, booking date, quote amount for one customer, proposal status, and one-off task are temporary/customer state, not standing policy.
- A recurring vendor workflow, durable vendor relationship, repeated procedure, stated service offering, policy, preference, or stable logistics rule may be durable.
- A message merely showing something happened once can support an operational_pattern candidate, but it is observation evidence, not authoritative policy.
- Direct business communication can be evidence about how the business operates, but do not convert a customer's wording into an owner policy.
- Consequential facts include payment/refund/legal/liability/compliance and broad pricing rules. Unless the source itself is authoritative, consequential facts require_confirmation.
- Use customer_safe only when the source authority in the supplied context actually grounds customer-facing use. Observation repetition alone does not create authority.
- Split semantically distinct owner statements into separate candidates. A list of current services should produce distinct service candidates when each service is independently retrievable.
- For owner_instruction or owner_correction sources, explicit current business facts, services, policies, pricing rules, service areas, procedures, and schedules should normally receive confidence 0.90-0.99 and customer_safe when not otherwise consequentially ambiguous.
- Explicit negative owner statements are durable too. For example, "we don't have a cancellation policy" should become a durable current policy/fact representing that no standing cancellation policy exists, not be discarded as missing data.
- Hypothetical, future, tentative, conditional, or uncertain statements such as "might", "maybe", "considering", "could offer later", or "thinking about" must remain speculative_observation candidates with confidence 0.40-0.69 and must never be rewritten as current offerings or policies.
- Do not collapse a speculative future possibility into an authoritative current fact merely because the speaker is the owner.
- If nothing is worth retaining, return an empty candidates array.`

export async function extractBusinessLearning(input: ExtractLearningInput): Promise<ExtractionResult> {
  try {
    const response = await loggedMessagesCreate(
      null,
      {
        model: 'auto',
        max_tokens: 1200,
        system: SYSTEM,
        messages: [{
          role: 'user',
          content:
            `Source kind: ${input.sourceKind}\n` +
            `Channel: ${input.sourceChannel ?? 'unknown'}\n` +
            `Authority: ${input.authority}\n` +
            `Metadata: ${JSON.stringify(input.sourceMetadata).slice(0, 1500)}\n\n` +
            `Observation:\n${input.content.slice(0, 12000)}`,
        }],
      },
      { source: 'lib/business-learning/extract.ts:extractBusinessLearning', task: 'fact_extraction', workspaceId: input.workspaceId }
    )

    const raw = response.content[0]?.type === 'text' ? response.content[0].text : ''
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()
    let parsed: unknown
    try {
      parsed = JSON.parse(cleaned)
    } catch {
      return { ok: false, reason: 'extractor output was not valid JSON' }
    }
    return validateExtraction(parsed)
  } catch (err) {
    return { ok: false, reason: `extractor call failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

export function validateExtraction(raw: unknown): ExtractionResult {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'extractor output is not an object' }
  const rows = (raw as { candidates?: unknown }).candidates
  if (!Array.isArray(rows)) return { ok: false, reason: 'extractor output missing candidates array' }

  const candidates: ExtractedLearningCandidate[] = []
  for (const [index, value] of rows.entries()) {
    if (!value || typeof value !== 'object') return { ok: false, reason: `candidate ${index} is not an object` }
    const r = value as Record<string, unknown>
    const allowedKinds = new Set(['durable_fact','temporary_state','customer_state','preference','procedure','policy','service_info','operational_pattern','speculative_observation'])
    const allowedCategories = new Set(['policy','service_detail','special_handling','logistics'])
    const allowedTargets = new Set(['workspace','service','customer','specific_date','unknown'])
    const allowedUse = new Set(['customer_safe','requires_confirmation','internal_only'])
    if (!allowedKinds.has(String(r.kind))) return { ok: false, reason: `candidate ${index} has invalid kind` }
    if (typeof r.durable !== 'boolean') return { ok: false, reason: `candidate ${index} missing durable` }
    if (!allowedCategories.has(String(r.category))) return { ok: false, reason: `candidate ${index} has invalid category` }
    if (typeof r.propertyKey !== 'string' || !r.propertyKey.trim()) return { ok: false, reason: `candidate ${index} missing propertyKey` }
    if (typeof r.valueText !== 'string' || r.valueText.trim().length < 3) return { ok: false, reason: `candidate ${index} missing valueText` }
    if (!r.scope || typeof r.scope !== 'object') return { ok: false, reason: `candidate ${index} missing scope` }
    const scope = r.scope as Record<string, unknown>
    if (!allowedTargets.has(String(scope.target))) return { ok: false, reason: `candidate ${index} has invalid scope target` }
    if (typeof r.confidence !== 'number' || !Number.isFinite(r.confidence)) return { ok: false, reason: `candidate ${index} has invalid confidence` }
    if (typeof r.consequential !== 'boolean') return { ok: false, reason: `candidate ${index} missing consequential` }
    if (!allowedUse.has(String(r.customerUseState))) return { ok: false, reason: `candidate ${index} has invalid customerUseState` }

    candidates.push({
      kind: r.kind as ExtractedLearningCandidate['kind'],
      durable: r.durable,
      category: r.category as ExtractedLearningCandidate['category'],
      propertyKey: r.propertyKey.trim().slice(0, 160),
      valueText: r.valueText.trim().slice(0, 1000),
      scope: {
        target: scope.target as ExtractedLearningCandidate['scope']['target'],
        serviceName: typeof scope.serviceName === 'string' ? scope.serviceName.trim().slice(0, 160) : null,
        customerId: typeof scope.customerId === 'string' ? scope.customerId.trim().slice(0, 160) : null,
        dateISO: typeof scope.dateISO === 'string' ? scope.dateISO.trim().slice(0, 10) : null,
      },
      confidence: Math.max(0, Math.min(1, r.confidence)),
      consequential: r.consequential,
      customerUseState: r.customerUseState as ExtractedLearningCandidate['customerUseState'],
      rationale: typeof r.rationale === 'string' ? r.rationale.slice(0, 500) : '',
    })
  }
  return { ok: true, candidates }
}
