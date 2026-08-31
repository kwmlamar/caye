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

/**
 * Releases a reservation that was taken but never spent.
 *
 * Only ever called when NO submit click was dispatched — the caller proves
 * this with `submitClickedAt === null`, which is stamped immediately before
 * the click and therefore cannot be null if one happened.
 *
 * This exists because the reservation is taken BEFORE the browser opens (so
 * capacity is checked atomically before any consequential work), but several
 * safe refusals still lie between it and the click: an ambiguous submit
 * control, a failed last-moment authority revalidation, a challenge appearing
 * on the page. Keeping the reservation in those cases would be doubly wrong —
 * it would burn a day's capacity on an application that was never sent, and
 * because the reservation row is UNIQUE per application, it would also
 * permanently bar that application from ever being submitted.
 *
 * A reservation is never released once the click has been dispatched. An
 * uncertain send may well have reached the employer and must consume the same
 * finite capacity as a confirmed one.
 */
export async function releaseUnspentSubmissionReservation(claim: ApplicationClaim): Promise<boolean> {
  // Best-effort cleanup. This runs after the executor has already determined
  // the attempt's outcome, so it must never be able to change it: a thrown
  // error here would otherwise unwind into the executor's catch-all and
  // rewrite a correctly-classified result as an unexpected failure. Worst
  // case on failure is a conservatively-held reservation, which is safe.
  try {
    const supabase = createServiceClient()
    const { error } = await supabase
      .from('job_search_submission_reservations')
      .delete()
      .eq('application_id', claim.applicationId)
      .eq('claim_token', claim.token)
    if (error) console.error('[job-search] could not release unspent submission reservation', error.message)
    return !error
  } catch (err) {
    console.error('[job-search] could not release unspent submission reservation', err instanceof Error ? err.message : String(err))
    return false
  }
}
