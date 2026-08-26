import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { resolveServiceByName } from '@/lib/caye-agent/tools/_catalog-helpers'
import { findConflictingFact } from '@/lib/business-fact-conflict'
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
 */
export async function writeBusinessFact(args: {
  workspaceId: string
  callerRole: string
  classification: ClassificationResult
}): Promise<WriteOutcome> {
  const payload = args.classification.businessFact
  if (!payload) return { decision: 'error', reason: 'destination business_fact but no businessFact payload' }
  const canonicalKey = args.classification.canonicalKey
  if (!canonicalKey) return { decision: 'error', reason: 'missing canonicalKey for a routable classification' }

  const supabase = createServiceClient()

  const { data: existingRows, error: existingErr } = await supabase
    .from('business_facts')
    .select('id, fact, source, expires_at')
    .eq('workspace_id', args.workspaceId)
    .is('superseded_at', null)
  if (existingErr) return { decision: 'error', reason: `active-fact lookup failed: ${existingErr.message}` }

  const now = Date.now()
  const active = (existingRows ?? []).filter((r) => !r.expires_at || new Date(r.expires_at as string).getTime() > now)

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

  let serviceId: string | null = null
  if (args.classification.scope.target === 'service' && args.classification.scope.serviceName) {
    const lookup = await resolveServiceByName(supabase, args.workspaceId, args.classification.scope.serviceName)
    if (lookup.ok) serviceId = lookup.service.id
    // Resolution failure is not fatal here — the fact text itself still
    // names the service in prose; it just won't carry a structural
    // service_id, the same as every fact saved before this migration.
  }

  const supersedeId = conflictingRow && conflict.resolution === 'supersede' ? conflictingRow.id : null

  const { data: rpcResult, error } = await supabase
    .rpc('write_business_fact_atomic', {
      p_workspace_id: args.workspaceId,
      p_category: payload.category,
      p_fact: payload.text,
      p_source: 'owner-direct',
      p_created_by: args.callerRole,
      p_service_id: serviceId,
      p_canonical_key: canonicalKey,
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
    reason: row.superseded_id ? 'superseded a conflicting/same-topic active fact' : 'no conflicting active fact',
  }
}
