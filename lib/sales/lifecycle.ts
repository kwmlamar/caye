import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { SalesLifecycleEvent } from './lifecycle-transitions'

/**
 * The one write seam for the relationship state of an outreach lead.
 * Dispatch and inbox code own their messages; this module owns what those
 * facts mean to Sales. A caller must invoke it only after its side effect
 * actually succeeded.
 */
export type { SalesLifecycleEvent } from './lifecycle-transitions'

export interface RecordSalesLifecycleEvent {
  workspaceId: string
  leadId: string
  event: SalesLifecycleEvent
  /** A persisted message id or other stable fact. Replaying it is a no-op. */
  eventKey: string
  at?: string
  reason?: string | null
}

/**
 * The database function locks the lead row, records a unique replay receipt,
 * writes the transition and its reporting signal in one transaction. This is
 * deliberately a small lifecycle seam, not a new generic work/event system.
 */
export async function recordSalesLifecycleEvent(input: RecordSalesLifecycleEvent): Promise<{ applied: boolean }> {
  const supabase = createServiceClient()
  const { data, error } = await supabase.rpc('sales_apply_lifecycle_event', {
    p_workspace_id: input.workspaceId,
    p_lead_id: input.leadId,
    p_event: input.event,
    p_event_key: input.eventKey,
    p_at: input.at ?? new Date().toISOString(),
    p_reason: input.reason ?? null,
  })
  if (error) throw new Error(`sales lifecycle ${input.event} was not recorded: ${error.message}`)
  return { applied: data === true }
}
