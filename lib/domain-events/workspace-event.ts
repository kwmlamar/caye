import type { NormalizedDomainEvent } from './types'

export type WorkspaceEventInsert = {
  workspace_id: string
  occurred_at: string
  type: string
  actor_kind: 'outside' | 'caye' | 'operator' | 'system' | 'unknown'
  is_failure: boolean
  subject_table: string
  subject_id: string
  payload: Record<string, unknown>
  origin: 'app'
}

/** Maps a normalized operational event onto Caye's existing canonical workspace event envelope. */
export function toWorkspaceEventInsert(event: NormalizedDomainEvent): WorkspaceEventInsert {
  const actorKind =
    event.actor.kind === 'external' ? 'outside' : event.actor.kind === 'operator' ? 'operator' : event.actor.kind === 'system' ? 'system' : 'unknown'

  return {
    workspace_id: event.workspaceId,
    occurred_at: event.occurredAt,
    type: event.type,
    actor_kind: actorKind,
    is_failure: false,
    subject_table: 'external_domain_entity',
    subject_id: `${event.sourceSystem}:${event.sourceEntityType}:${event.sourceEntityId}`,
    payload: {
      epistemic_kind: 'operational_event',
      observed_at: event.observedAt,
      change_kind: event.changeKind,
      attention_eligible: event.attentionEligible,
      entity: {
        caye_entity_id: event.cayeEntityId ?? null,
        resolution: event.cayeEntityId ? 'resolved' : 'unresolved',
      },
      source: {
        system: event.sourceSystem,
        company_id: event.sourceCompanyId,
        entity_type: event.sourceEntityType,
        entity_id: event.sourceEntityId,
        event_id: event.sourceEventId ?? null,
        version: event.sourceVersion ?? null,
        idempotency_key: event.idempotencyKey,
        metadata: event.sourceMetadata,
      },
      actor: event.actor,
      changes: event.changes,
      related_entities: event.relatedEntities,
      evidence: event.evidence ?? null,
    },
    origin: 'app',
  }
}
