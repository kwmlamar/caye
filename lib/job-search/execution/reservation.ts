import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { ApplicationClaim } from './claim'

/**
 * A reservation is intentionally never released after a browser is allowed to
 * click Submit. An uncertain send may have reached the employer and therefore
 * consumes the same finite capacity as a confirmed submission.
 */
export async function reserveSubmissionSlot(claim: ApplicationClaim): Promise<boolean> {
  const supabase = createServiceClient()
  const { data, error } = await supabase.rpc('reserve_job_search_submission_slot', {
    p_application_id: claim.applicationId,
    p_claim_token: claim.token,
  })
  return !error && data === true
}
