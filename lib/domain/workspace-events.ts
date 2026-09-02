/**
 * How a canonical business entity identity travels on `workspace_events`.
 *
 * `workspace_events` is not redesigned and needs no migration. It already
 * carries `subject_table` / `subject_id` plus an open `payload`, and the domain
 * event bridge writes the resolved identity at
 * `payload.entity.caye_entity_id`. This module states that convention in one
 * place so the bridge, perception and any later reader agree on where to look
 * rather than each inventing a path.
 *
 * Two shapes are recognised on read:
 *
 *   1. `payload.entity.caye_entity_id` — what the external domain bridge
 *      writes. `subject_table`/`subject_id` stay pinned to the EXTERNAL record
 *      there, which is correct: the subject of that event is a Bedrock
 *      purchase order, and the Caye identity is how Caye files it.
 *   2. `subject_table = 'business_entities'` — for events whose subject really
 *      is the Caye identity itself (an entity registered, merged, archived).
 *
 * Resolution can legitimately fail. An unresolved event is recorded with a
 * null identity and an explicit 'unresolved' marker rather than being dropped
 * or silently attached to the wrong thing.
 */

export const BUSINESS_ENTITY_SUBJECT_TABLE = 'business_entities'

export type BusinessEntityResolutionState = 'resolved' | 'unresolved'

export interface WorkspaceEventEntityRef {
  caye_entity_id: string | null
  resolution: BusinessEntityResolutionState
}

/** Builds the `payload.entity` fragment carried by domain events. */
export function workspaceEventEntityRef(businessEntityId: string | null | undefined): WorkspaceEventEntityRef {
  const id = typeof businessEntityId === 'string' && businessEntityId.trim().length > 0
    ? businessEntityId.trim()
    : null
  return { caye_entity_id: id, resolution: id ? 'resolved' : 'unresolved' }
}

/** Subject fields for an event whose subject is the Caye identity itself. */
export function businessEntitySubject(businessEntityId: string): {
  subject_table: string
  subject_id: string
} {
  return { subject_table: BUSINESS_ENTITY_SUBJECT_TABLE, subject_id: businessEntityId }
}

type WorkspaceEventLike = {
  subject_table?: string | null
  subject_id?: string | null
  payload?: unknown
}

/**
 * Reads the canonical identity off a workspace event, or null when the event
 * carries none. Never guesses: an event with an unresolved entity reference
 * returns null rather than falling back to an external id, because an external
 * id is not a Caye identity.
 */
export function businessEntityIdFromWorkspaceEvent(event: WorkspaceEventLike): string | null {
  const payload = event.payload
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const entity = (payload as Record<string, unknown>).entity
    if (entity && typeof entity === 'object' && !Array.isArray(entity)) {
      const value = (entity as Record<string, unknown>).caye_entity_id
      if (typeof value === 'string' && value.trim().length > 0) return value.trim()
    }
  }

  if (event.subject_table === BUSINESS_ENTITY_SUBJECT_TABLE) {
    const id = event.subject_id
    if (typeof id === 'string' && id.trim().length > 0) return id.trim()
  }

  return null
}
