import 'server-only'
import type { createServiceClient } from '@/lib/supabase-server'
import { resolveServiceByName } from '@/lib/caye-agent/tools/_catalog-helpers'
import { tokenize, LOW_SIGNAL_WORDS } from '@/lib/services/match-service'

/**
 * operator-learning/service-grounding.ts
 *
 * Closes "wrong-but-resolved scope" — the risk that a deterministic string
 * match on the CLASSIFIER'S OWN paraphrase of which service was meant can
 * be confidently, unambiguously wrong, in two distinct ways real Bimini
 * data confirms both happen:
 *
 * 1. NEAR-COLLISION CATALOG NAMES. Confirmed live: the catalog carries
 *    three real, active, similarly-named services — "Golf Cart Guided
 *    Tour" (the original, still has an "Orientation 1hr (group)" tier at
 *    $110/person, last touched 2026-06-05), "Golf Cart Orientation Tour",
 *    and "Golf Cart Fully Guided Tour" (the two newer services an owner
 *    correction on 2026-08-14 built to REPLACE the first one — but the
 *    original was never deactivated). "The golf cart tour" said today
 *    could plausibly mean any of three real services with different,
 *    inconsistent pricing. matchServiceByName's highMargin already
 *    protects against a razor-thin lead, but this is defense in depth:
 *    resolveServiceByName alone doesn't know WHICH of a margin-clearing
 *    match's underlying tokens actually came from what the operator said,
 *    versus what the classifier inferred/summarized.
 * 2. STALE-CONTEXT MIS-ATTRIBUTION. The classifier's `serviceName` field is
 *    ITS OWN paraphrase/summary, built from the raw statement PLUS
 *    whatever conversational context it saw — including `previousCayeText`.
 *    A classifier can hallucinate or context-bleed a service name from an
 *    earlier turn that the CURRENT statement was never actually about.
 *    matchServiceByName scoring the classifier's own (possibly wrong)
 *    string confidently against the catalog proves nothing about whether
 *    that string reflects what the operator actually said just now.
 *
 * THE SAFEGUARD: after resolveServiceByName succeeds, require that the
 * resolved service's own name shares at least one MEANINGFUL (non-filler)
 * token with the operator's RAW, UNSUMMARIZED statement — the one piece of
 * "bounded authoritative context" available for every correction, since
 * operator webhook corrections aren't reliably tied to one customer
 * booking the way a Front Desk turn is. This is a hard requirement, not a
 * confidence signal: zero meaningful overlap is deterministic ambiguity,
 * full stop, regardless of how cleanly the classifier's own paraphrase
 * scored against the catalog.
 *
 * Deliberately does NOT raise any confidence threshold — this is an
 * independent, structural gate that runs whether the classifier reported
 * confidence 0.99 or 0.56.
 */

export interface GroundedServiceResult {
  ok: boolean
  service: { id: string; name: string } | null
  error: string | null
  candidates?: string[]
}

export async function resolveGroundedService(
  supabase: ReturnType<typeof createServiceClient>,
  workspaceId: string,
  classifierServiceName: string,
  rawOperatorText: string
): Promise<GroundedServiceResult> {
  const lookup = await resolveServiceByName(supabase, workspaceId, classifierServiceName)
  if (!lookup.ok) {
    return { ok: false, service: null, error: lookup.error, candidates: lookup.candidates }
  }

  if (!serviceMentionGrounded(rawOperatorText, lookup.service.name)) {
    return {
      ok: false,
      service: null,
      error: `resolved to "${lookup.service.name}" but none of its distinguishing words appear in what the operator actually said ("${rawOperatorText.slice(0, 200)}") — the classifier's own paraphrase may not reflect this statement`,
    }
  }

  return { ok: true, service: lookup.service, error: null }
}

/**
 * True when at least one MEANINGFUL (non-filler) token of the resolved
 * service's name appears, after the same tokenize/synonym normalization
 * matchServiceByName itself uses, in the raw operator text. A service name
 * with zero meaningful tokens of its own (no real service in this catalog
 * has that shape, but fail open rather than block every write on a
 * pathological catalog entry) is vacuously grounded — there's nothing
 * distinguishing to check.
 */
export function serviceMentionGrounded(rawText: string, resolvedServiceName: string): boolean {
  const serviceTokens = tokenize(resolvedServiceName).filter((t) => !LOW_SIGNAL_WORDS.has(t))
  if (serviceTokens.length === 0) return true
  const rawTokens = new Set(tokenize(rawText).filter((t) => !LOW_SIGNAL_WORDS.has(t)))
  return serviceTokens.some((t) => rawTokens.has(t))
}
