import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { findConflictingFact } from '@/lib/business-fact-conflict'
import { findSemanticFactMatch } from '@/lib/business-fact-semantic-match'
import { resolveGroundedService } from '../service-grounding'
import type { ClassificationResult } from '../schema'
import type { WriteOutcome } from './types'

/**
 * writers/business-fact-writer.ts
 *
 * Reuses the SAME contradiction judge (findConflictingFact) the
 * add_business_fact / confirm_fact_candidate tools already use — one judge,
 * two producers. Writes through the NEW write_business_fact_atomic RPC
 * (20260826_business_facts_scope_and_canonical_key.sql), additive alongside
 * the existing add_business_fact_with_supersession RPC which
 * add-business-fact.ts / confirm-fact-candidate.ts keep using unchanged.
 *
 * CANONICAL-KEY STABILITY (added after the 2026-08-26 historical-learning
 * audit against real Bimini production data). Confirmed live in production:
 * two active, redundant, never-merged business_facts rows about payment
 * method — one from 2026-08-10 ("card only... cash and Zelle are not
 * accepted"), one from 2026-08-25 ("only accepts online payment... do not
 * mention Cash or Zelle") — because they don't literally CONTRADICT each
 * other (both forbid cash/Zelle), findConflictingFact correctly found no
 * conflict, and nothing else checked whether they were the SAME topic
 * reworded. A classifier minting a fresh canonicalKey string on each call
 * (here: "payment-method" vs. a differently-worded key on a later, separate
 * classification) reproduces this exact bug — canonical_key alone is not a
 * reliable dedup key across independent LLM judgments made on different
 * days. So this ALSO runs findSemanticFactMatch (the same judge the passive
 * business-fact-suggestions.ts pipeline already trusts for "is this the
 * same fact reworded") against active facts before writing. A semantic
 * match wins over the classifier's own canonicalKey: the matched fact's
 * existing canonical_key is reused if it has one (so the RPC's row-lock
 * chain finds and supersedes it), or its id is passed as an explicit
 * supersede target if it predates this migration and has none.
 */
export async function writeBusinessFact(args: {
  workspaceId: string
  callerRole: string
  classification: ClassificationResult
  operatorText: string
}): Promise<WriteOutcome> {
  const payload = args.classification.businessFact
  if (!payload) return { decision: 'error', reason: 'destination business_fact but no businessFact payload' }
  const classifierCanonicalKey = args.classification.canonicalKey
  if (!classifierCanonicalKey) return { decision: 'error', reason: 'missing canonicalKey for a routable classification' }

  const supabase = createServiceClient()

  // Resolved BEFORE the conflict/dedup checks, deliberately, so both judges
  // can be told the new fact's own scope (see the scope-label enrichment
  // below) — not just handed bare text to compare.
  let serviceId: string | null = null
  let serviceName: string | null = null
  if (args.classification.scope.target === 'service' && args.classification.scope.serviceName) {
    const lookup = await resolveGroundedService(supabase, args.workspaceId, args.classification.scope.serviceName, args.operatorText)
    if (lookup.ok && lookup.service) {
      serviceId = lookup.service.id
      serviceName = lookup.service.name
    } else if (args.classification.risk === 'consequential') {
      // Consequential content is the one case where a "best-effort, fall
      // back to workspace-wide" resolution isn't good enough: writing a
      // service-specific refund/payment/legal policy as workspace-wide
      // because the service name didn't resolve would silently broaden its
      // scope beyond what was actually said. Every other write tool's
      // deterministic destination resolution (pricing, availability,
      // contact) already refuses outright on a failed lookup regardless of
      // risk — this makes business_fact consistent with that for the one
      // risk tier where the gap matters.
      return {
        decision: 'candidate',
        reason: `consequential content scoped to a specific service, but "${args.classification.scope.serviceName}" did not resolve: ${lookup.error}`,
      }
    }
    // Low-risk resolution failure is not fatal — the fact text itself
    // still names the service in prose; it just won't carry a structural
    // service_id, the same as every fact saved before this migration.
  }

  const { data: existingRows, error: existingErr } = await supabase
    .from('business_facts')
    .select('id, fact, source, expires_at, canonical_key, service_id')
    .eq('workspace_id', args.workspaceId)
    .is('superseded_at', null)
  if (existingErr) return { decision: 'error', reason: `active-fact lookup failed: ${existingErr.message}` }

  const now = Date.now()
  const active = (existingRows ?? []).filter((r) => !r.expires_at || new Date(r.expires_at as string).getTime() > now) as Array<{
    id: string
    fact: string
    source: string
    expires_at: string | null
    canonical_key: string | null
    service_id: string | null
  }>

  // Scope labels for the LLM judges — real production evidence (2026-08-26
  // historical-learning audit) motivated this: "The meeting point for the
  // Heritage Tour is the pink building by the dock" (service-scoped,
  // 2026-06-25) and "The pickup location for all tours is the Casino Tram
  // Stop" (workspace-wide, 2026-08-26) are BOTH still active in production
  // today — an unresolved case where a general statement may or may not
  // actually override a specific one. Handing the judges bare fact text
  // gives them no way to reason about that; a workspace-wide claim reads as
  // unrelated to "the Heritage Tour" unless it's told the existing fact IS
  // Heritage-Tour-specific and that the new one claims to cover "all
  // tours". Distinct active service_ids get one batched lookup.
  const scopedServiceIds = Array.from(new Set(active.map((r) => r.service_id).filter((id): id is string => !!id)))
  const scopeNameById = new Map<string, string>()
  if (scopedServiceIds.length > 0) {
    const { data: scopedServices } = await supabase
      .from('booking_services')
      .select('id, name')
      .in('id', scopedServiceIds)
    for (const s of (scopedServices ?? []) as { id: string; name: string }[]) scopeNameById.set(s.id, s.name)
  }
  const scopeLabelFor = (r: { service_id: string | null }): string | undefined =>
    r.service_id ? `specific to ${scopeNameById.get(r.service_id) ?? 'one service'}` : 'workspace-wide (applies to all services)'
  const newFactScopeLabel = serviceId ? `specific to ${serviceName ?? 'one service'}` : 'workspace-wide (applies to all services)'

  const conflict = await findConflictingFact(
    payload.text,
    active.map((r) => ({ id: r.id, text: r.fact, source: r.source, scopeLabel: scopeLabelFor(r) })),
    { workspaceId: args.workspaceId, source: 'operator-learning/writers/business-fact-writer.ts', newFactScopeLabel }
  )

  if (conflict.checkFailed) {
    return { decision: 'error', reason: 'conflict check against active facts failed — refusing to write unverified' }
  }

  const conflictingRow = conflict.conflictId ? active.find((r) => r.id === conflict.conflictId) : undefined
  if (conflictingRow && conflict.resolution === 'ambiguous') {
    return {
      decision: 'candidate',
      reason: `may conflict with an existing fact ("${conflictingRow.fact}") without clearly replacing it`,
    }
  }

  // Same-topic dedup, independent of whether the two statements literally
  // contradict each other. See the module doc above — this is what
  // prevents a second, compatibly-worded restatement of an already-active
  // fact from becoming a second permanently-active row. Scope-blind by
  // design: findSemanticFactMatch answers "is this the SAME fact reworded",
  // and a workspace-wide fact and a service-scoped fact are never the same
  // fact even if they're about the same topic — that distinction is exactly
  // what the conflict judge above (not this dedup judge) is responsible for.
  const { matchId: semanticMatchId } = await findSemanticFactMatch(
    payload.text,
    active.map((r) => ({ id: r.id, text: r.fact })),
    { workspaceId: args.workspaceId, source: 'operator-learning/writers/business-fact-writer.ts:dedup' }
  )
  const semanticMatchRow = semanticMatchId ? active.find((r) => r.id === semanticMatchId) : undefined

  // Effective chain target: an explicit contradiction the judge found wins
  // (it already reasoned about resolution); otherwise a same-topic semantic
  // match supersedes even though the two aren't in literal contradiction.
  const supersedeId =
    (conflictingRow && conflict.resolution === 'supersede' ? conflictingRow.id : null) ??
    (semanticMatchRow ? semanticMatchRow.id : null)

  // Reuse the matched fact's own canonical_key when it has one, so this
  // write joins its existing chain instead of starting a parallel one under
  // a differently-worded key the classifier happened to mint this time.
  const effectiveCanonicalKey = semanticMatchRow?.canonical_key ?? classifierCanonicalKey

  const { data: rpcResult, error } = await supabase
    .rpc('write_business_fact_atomic', {
      p_workspace_id: args.workspaceId,
      p_category: payload.category,
      p_fact: payload.text,
      p_source: 'owner-direct',
      p_created_by: args.callerRole,
      p_service_id: serviceId,
      p_canonical_key: effectiveCanonicalKey,
      p_expires_at: null,
      p_supersede_id: supersedeId,
    })
    .single()

  if (error) return { decision: 'error', reason: `write_business_fact_atomic failed: ${error.message}` }

  const row = rpcResult as { id: string; created_at: string; superseded_id: string | null }
  return {
    decision: row.superseded_id ? 'superseded_and_written' : 'written',
    targetTable: 'business_facts',
    targetRecordId: row.id,
    supersededRecordId: row.superseded_id,
    reason: row.superseded_id
      ? semanticMatchRow && !conflictingRow
        ? 'superseded a same-topic active fact (semantic match, not a literal contradiction)'
        : 'superseded a conflicting/same-topic active fact'
      : 'no conflicting or same-topic active fact',
  }
}
