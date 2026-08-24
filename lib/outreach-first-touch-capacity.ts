import 'server-only'
import { createServiceClient } from './supabase-server'
import { OUTREACH_DAILY_FIRST_TOUCH_CAP } from './outreach-send-limits'

/** Atomically reserve one campaign slot before an external first-touch send. */
export async function reserveFirstTouchCapacity(workspaceId: string, leadId: string, now: Date): Promise<boolean> {
  const { data, error } = await createServiceClient().rpc('reserve_outreach_first_touch_capacity', {
    p_workspace_id: workspaceId,
    p_lead_id: leadId,
    p_day: now.toISOString().slice(0, 10),
    p_cap: OUTREACH_DAILY_FIRST_TOUCH_CAP,
  })
  if (error) throw new Error(`could not reserve first-touch capacity: ${error.message}`)
  return data === true
}
