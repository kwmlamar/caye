import 'server-only'
import type { createServiceClient } from '@/lib/supabase-server'
import { matchServiceByName, extractCustomerTourName, extractCustomerRequestedDate } from '@/lib/services/match-service'
import { evaluateDateOverride, type ServiceDateOverride } from '@/lib/services/service-availability'

/**
 * date-override-revalidation.ts
 *
 * Closes the gap identified in the 2026-08-26 historical-learning audit of
 * PR #133 (Operator Learning Router): a Front Desk turn's prompt is built
 * from availability state read at PROMPT-build time, but send_customer_reply
 * executes later in the same turn (after tool calls, possibly after model
 * thinking time). If an operator teaches a date-specific restriction via the
 * router WHILE that turn is in flight, the draft composed before the
 * teaching happened must not go out unrevalidated.
 *
 * Deliberately narrow and deterministic, matching the existing guards in
 * this directory (logistics-grounding.ts, policy-figure-guard.ts): this does
 * NOT re-run the whole prompt or re-derive availability from scratch. It
 * re-fetches service_date_overrides fresh, for the specific service+date the
 * CUSTOMER'S OWN words establish (never the draft's own claims — a draft
 * cannot ground itself), and flags two bounded failure shapes:
 *   - the date is now fully unavailable, but the draft doesn't read like a
 *     refusal (no refusal-shaped language at all);
 *   - the date is now restricted to one variant, but the draft names a
 *     DIFFERENT real variant of that same service without mentioning the
 *     restriction.
 * A miss here (an override that's hard to detect from wording) costs what it
 * already would have without this check — a human eventually sees it via
 * business_facts/support. A false positive costs one unnecessary hold. Given
 * the failure mode this exists to prevent (a customer holding a business to
 * a promise that was already retracted), that tradeoff is deliberate.
 *
 * Composition note (PR #132, conversation-execution-coordination, was still
 * open/unmerged when this was written): this is a content-freshness check,
 * not a concurrency/claim mechanism — orthogonal to what PR #132 solves. It
 * is written against `main` as of this branch's base and does not import or
 * depend on anything from PR #132's branch. Once PR #132 lands, whichever
 * merges second should consider whether this check belongs inside that
 * claim boundary too; nothing here needs to change for that to happen.
 */

const REFUSAL_SIGNAL = /\b(cannot|can't|not able to|unable to|not available|unavailable|closed|do not run|doesn't run|does not run)\b/i

export async function staleDateOverrideConflict(
  supabase: ReturnType<typeof createServiceClient>,
  workspaceId: string,
  conversationId: string,
  draftBody: string
): Promise<string | null> {
  const { data: customerRows } = await supabase
    .from('unified_messages')
    .select('content')
    .eq('conversation_id', conversationId)
    .eq('is_internal', false)
    .eq('sender_type', 'customer')
    .order('sent_at', { ascending: true })
    .limit(50)
  const customerThread = (customerRows ?? []).map((r) => (r as { content: string | null }).content || '').join('\n')
  if (!customerThread) return null

  const tourName = extractCustomerTourName(customerThread)
  const dateISO = extractCustomerRequestedDate(customerThread)
  if (!tourName || !dateISO) return null

  const { data: services } = await supabase
    .from('booking_services')
    .select('id, name')
    .eq('user_id', workspaceId)
    .eq('active', true)
  const candidates = ((services ?? []) as { id: string; name: string }[]).map((s) => ({ id: s.id, name: s.name }))
  const match = matchServiceByName(candidates, tourName)
  if (!match.best || match.confidence !== 'high') return null

  const { data: overrideRows } = await supabase
    .from('service_date_overrides')
    .select('id, date_iso, effect, min_party, restricted_variant, note')
    .eq('workspace_id', workspaceId)
    .eq('service_id', match.best.id)
    .eq('date_iso', dateISO)
    .eq('is_active', true)
    .limit(5)
  const overrides = (overrideRows ?? []) as ServiceDateOverride[]
  if (overrides.length === 0) return null

  const verdict = evaluateDateOverride({ overrides, dateISO })
  if (!verdict) return null

  if (verdict.status === 'unavailable') {
    if (!REFUSAL_SIGNAL.test(draftBody)) {
      return (
        `"${match.best.name}" was just marked unavailable on ${dateISO}` +
        (verdict.reason ? ` (${verdict.reason})` : '') +
        ', but the draft does not read as a refusal for that date.'
      )
    }
    return null
  }

  if (verdict.status === 'variant_restricted') {
    const { data: tierRows } = await supabase
      .from('service_pricing_tiers')
      .select('variant')
      .eq('service_id', match.best.id)
      .eq('workspace_id', workspaceId)
    const variants = new Set(
      ((tierRows ?? []) as { variant: string | null }[]).map((t) => t.variant).filter((v): v is string => !!v)
    )
    const lowerBody = draftBody.toLowerCase()
    const mentionsRestrictedVariant = lowerBody.includes(verdict.restrictedToVariant.toLowerCase())
    const mentionsOtherVariant = Array.from(variants).some(
      (v) => v.toLowerCase() !== verdict.restrictedToVariant.toLowerCase() && lowerBody.includes(v.toLowerCase())
    )
    if (mentionsOtherVariant && !mentionsRestrictedVariant) {
      return (
        `"${match.best.name}" on ${dateISO} was just restricted to the ${verdict.restrictedToVariant} option only` +
        (verdict.reason ? ` (${verdict.reason})` : '') +
        `, but the draft offers a different variant without mentioning that restriction.`
      )
    }
    return null
  }

  return null
}
