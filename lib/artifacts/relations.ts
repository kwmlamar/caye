import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'

/**
 * Operator-confirmed meaning and relationship writes for Multimodal Business
 * Memory (#87).
 *
 * This is the ONLY path that writes provenance_status='operator_confirmed' /
 * provenance='operator_confirmed' — model-derived understanding from
 * lib/artifacts/process.ts never claims operator confirmation for itself.
 * Mirrors business_facts' supersession model exactly: the prior row is
 * marked superseded_at/superseded_by, never mutated or deleted, so history
 * (including the model's original low-confidence guess) survives a
 * correction — see acceptance criterion #14.
 *
 * Composes with the existing operator-learning authority model rather than
 * inventing a second one: durable-meaning writes are owner/founder only,
 * same WRITE_AUTHORIZED_ROLES boundary lib/operator-learning/route-decision.ts
 * already enforces for business_facts/pricing/etc.
 */

export interface AnnotateArtifactInput {
  workspaceId: string
  artifactId: string
  operatorAllowlistId: number
  meaning: string
  relationType?: string
  targetEntityType?: string
  targetEntityId?: string
}

export type AnnotateArtifactResult =
  | { ok: true; observationId: string; relationId: string | null }
  | { ok: false; error: string }

export async function annotateArtifact(input: AnnotateArtifactInput): Promise<AnnotateArtifactResult> {
  const supabase = createServiceClient()

  const { data: artifact } = await supabase
    .from('business_artifacts')
    .select('id')
    .eq('workspace_id', input.workspaceId)
    .eq('id', input.artifactId)
    .maybeSingle()
  if (!artifact) return { ok: false, error: 'Artifact not found in this workspace.' }

  // Supersede the previous operator_annotation, if any — one authoritative
  // operator-confirmed meaning at a time, prior guesses retained for history.
  const { data: priorAnnotation } = await supabase
    .from('business_artifact_observations')
    .select('id')
    .eq('artifact_id', input.artifactId)
    .eq('observation_type', 'operator_annotation')
    .is('superseded_at', null)
    .maybeSingle()

  const { data: newObservation, error: obsError } = await supabase
    .from('business_artifact_observations')
    .insert({
      artifact_id: input.artifactId,
      workspace_id: input.workspaceId,
      observation_type: 'operator_annotation',
      modality: null,
      content: { meaning: input.meaning },
      confidence: null,
      provenance_status: 'operator_confirmed',
      derived_by: `operator:${input.operatorAllowlistId}`,
    })
    .select('id')
    .single()
  if (obsError || !newObservation) return { ok: false, error: obsError?.message ?? 'failed to save annotation' }

  if (priorAnnotation) {
    await supabase
      .from('business_artifact_observations')
      .update({ superseded_at: new Date().toISOString(), superseded_by: newObservation.id })
      .eq('id', priorAnnotation.id)
  }

  // Also mark any prior LOW-confidence model observation as superseded in
  // spirit — we don't delete/mutate it, but an operator_confirmed annotation
  // now exists and callers/tools should prefer it. No row change needed
  // beyond the annotation itself; retrieval (query.ts) already prefers
  // confirmed relations/annotations by construction.

  let relationId: string | null = null
  if (input.targetEntityType && input.targetEntityId) {
    const relationType = input.relationType ?? 'relates_to'

    const { data: priorRelation } = await supabase
      .from('business_artifact_relations')
      .select('id')
      .eq('artifact_id', input.artifactId)
      .eq('target_entity_type', input.targetEntityType)
      .eq('target_entity_id', input.targetEntityId)
      .eq('status', 'confirmed')
      .is('superseded_at', null)
      .maybeSingle()

    // Supersede the PRIOR confirmed relation before inserting the new one —
    // business_artifact_relations_confirmed_idx is a partial unique index on
    // (artifact_id, target_entity_type, target_entity_id) WHERE
    // status='confirmed' AND superseded_at IS NULL. Inserting the new
    // confirmed row first (while the old one is still active) violates that
    // constraint for real in Postgres — this ordering is not cosmetic.
    if (priorRelation) {
      await supabase
        .from('business_artifact_relations')
        .update({ superseded_at: new Date().toISOString() })
        .eq('id', priorRelation.id)
    }

    const { data: newRelation, error: relError } = await supabase
      .from('business_artifact_relations')
      .insert({
        workspace_id: input.workspaceId,
        artifact_id: input.artifactId,
        relation_type: relationType,
        target_entity_type: input.targetEntityType,
        target_entity_id: input.targetEntityId,
        label: input.meaning.slice(0, 200),
        status: 'confirmed',
        confidence: null,
        provenance: priorRelation ? 'operator_corrected' : 'operator_confirmed',
        source_observation_id: newObservation.id,
        confirmed_by_operator_allowlist_id: input.operatorAllowlistId,
        confirmed_at: new Date().toISOString(),
        corrected_from_relation_id: priorRelation?.id ?? null,
      })
      .select('id')
      .single()

    if (relError || !newRelation) {
      // The prior relation (if any) is already superseded at this point —
      // never leave that silent. A genuinely failed insert here means no
      // CURRENT confirmed relation exists for this target until retried;
      // the operator-confirmed annotation observation above still stands
      // as evidence either way (it isn't rolled back), but the caller must
      // know this half didn't land rather than reporting a false ok:true.
      return { ok: false, error: relError?.message ?? 'failed to save relation' }
    }
    relationId = newRelation.id
  }

  return { ok: true, observationId: newObservation.id, relationId }
}
