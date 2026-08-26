import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { resolveServiceByName } from '@/lib/caye-agent/tools/_catalog-helpers'
import { findConflictingFact } from '@/lib/business-fact-conflict'
import { findSemanticFactMatch } from '@/lib/business-fact-semantic-match'
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
}): Promise<WriteOutcome> {
  const payload = args.classification.businessFact
  if (!payload) return { decision: 'error', reason: 'destination business_fact but no businessFact payload' }
  const classifierCanonicalKey = args.classification.canonicalKey
  if (!classifierCanonicalKey) return { decision: 'error', reason: 'missing canonicalKey for a routable classification' }

  const supabase = createServiceClient()

  const { data: existingRows, error: existingErr } = await supabase
    .from('business_facts')
    .select('id, fact, source, expires_at, canonical_key')
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
  }>

  const conflict = await findConflictingFact(
    payload.text,
    active.map((r) => ({ id: r.id, text: r.fact, source: r.source })),
    { workspaceId: args.workspaceId, source: 'operator-learning/writers/business-fact-writer.ts' }
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
  // fact from becoming a second permanently-active row.
  const { matchId: semanticMatchId } = await findSemanticFactMatch(
    payload.text,
    active.map((r) => ({ id: r.id, text: r.fact })),
    { workspaceId: args.workspaceId, source: 'operator-learning/writers/business-fact-writer.ts:dedup' }
  )
  const semanticMatchRow = semanticMatchId ? active.find((r) => r.id === semanticMatchId) : undefined

  let serviceId: string | null = null
  if (args.classification.scope.target === 'service' && args.classification.scope.serviceName) {
    const lookup = await resolveServiceByName(supabase, args.workspaceId, args.classification.scope.serviceName)
    if (lookup.ok) serviceId = lookup.service.id
    // Resolution failure is not fatal here — the fact text itself still
    // names the service in prose; it just won't carry a structural
    // service_id, the same as every fact saved before this migration.
  }

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
