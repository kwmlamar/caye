import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { CLASSIFIER_VERSION } from './schema'
import type { ClassificationResult } from './schema'

/**
 * operator-learning/audit.ts
 *
 * One row per classification/write decision, whether or not anything was
 * actually written. See supabase/migrations/20260826c_operator_learning_audit.sql
 * for the schema and the "not a knowledge store" note.
 */

export type LearningDecision = 'written' | 'superseded_and_written' | 'candidate' | 'no_op' | 'rejected' | 'error'

export interface AuditInput {
  workspaceId: string
  sourceOperatorId: number | null
  sourceOperatorRole: string
  sourceMessageId: string | null
  sourceConversationId: string | null
  /** Capped to 500 chars before insert — matches business_facts.source_excerpt's convention. Operator's own words only; customers never reach this pipeline. */
  sourceExcerpt: string
  classification: ClassificationResult | null
  decision: LearningDecision
  targetTable: string | null
  targetRecordId: string | null
  supersededRecordId: string | null
  reason: string
}

export async function recordLearningAudit(input: AuditInput): Promise<void> {
  const supabase = createServiceClient()
  const c = input.classification
  const { error } = await supabase.from('operator_learning_audit').insert({
    workspace_id: input.workspaceId,
    source_operator_id: input.sourceOperatorId,
    source_operator_role: input.sourceOperatorRole,
    source_message_id: input.sourceMessageId,
    source_conversation_id: input.sourceConversationId,
    source_excerpt: input.sourceExcerpt.slice(0, 500),
    classifier_version: CLASSIFIER_VERSION,
    explicitness: c?.explicitness ?? null,
    scope_kind: c?.scope.kind ?? null,
    scope_target: c?.scope.target ?? null,
    risk_level: c?.risk ?? null,
    destination: c?.destination ?? null,
    canonical_key: c?.canonicalKey ?? null,
    decision: input.decision,
    target_table: input.targetTable,
    target_record_id: input.targetRecordId,
    superseded_record_id: input.supersededRecordId,
    reason: input.reason.slice(0, 500),
  })
  if (error) {
    // The audit write itself failing must not throw back into the router —
    // it's already the last step of a best-effort background pipeline.
    console.error('[operator-learning-audit] insert failed:', error.message)
  }
}

/**
 * Idempotency gate: has this exact inbound message already been processed?
 * Checked before the classifier runs at all, so a duplicate WhatsApp webhook
 * delivery costs one cheap indexed lookup, not a second LLM call and a
 * second write attempt.
 */
export async function alreadyProcessed(workspaceId: string, sourceMessageId: string | null): Promise<boolean> {
  if (!sourceMessageId) return false
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('operator_learning_audit')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('source_message_id', sourceMessageId)
    .limit(1)
    .maybeSingle()
  if (error) {
    // Fail OPEN here: if we can't tell whether this was already processed,
    // proceeding risks a duplicate classification (wasteful, self-corrects
    // via the canonical-key chain / DB uniqueness at write time) — safer
    // than silently refusing to ever learn from a message because the
    // idempotency check itself is unreachable.
    console.error('[operator-learning-audit] idempotency check failed:', error.message)
    return false
  }
  return !!data
}
