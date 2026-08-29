/**
 * Job-search operator (CAY-194 / #194) — human-readable blocker phrasing.
 *
 * Turns an internal semantic key / outcome category into the exact kind of
 * founder-facing sentence the issue's "Human review" section asks for
 * (e.g. "Company asks whether you will ever require sponsorship"). Kept as
 * one small lookup so the phrasing used by the Admin Shell tools and the
 * blockers recorded on job_search_execution_attempts stay in sync.
 */

const SEMANTIC_KEY_PHRASES: Record<string, string> = {
  sponsorship: 'Company asks whether you will ever require visa sponsorship',
  work_authorization: 'Company asks about work authorization in a way that is not clearly resolved',
  citizenship: 'Company asks about citizenship status',
  clearance: 'Company asks about security clearance',
  criminal_history: 'Application asks about criminal history',
  disability: 'Application includes a disability self-identification question',
  veteran_status: 'Application includes a veteran-status self-identification question',
  demographic: 'Application includes a demographic self-identification question',
  relocation: 'Application asks whether you are willing to relocate',
  compensation: 'Application requires desired compensation',
  legal_attestation: 'Application requires a legal attestation/certification',
  willingness_to_travel: 'Application asks about willingness to travel',
  drivers_license: "Application asks about a driver's license",
  availability_start_date: 'Application asks for a specific availability/start date',
  background_check_acknowledgment: 'Application requires a background-check acknowledgment',
  arbitration_acknowledgment: 'Application requires an arbitration/binding-legal acknowledgment',
}

export function describeBlockerCategory(category: string): string {
  if (SEMANTIC_KEY_PHRASES[category]) return SEMANTIC_KEY_PHRASES[category]
  switch (category) {
    case 'captcha':
      return 'CAPTCHA encountered'
    case 'anti_bot':
      return 'Anti-bot/challenge response encountered'
    case 'prohibited_destination':
      return 'Apply destination is not a safe/allowed automation target'
    case 'unknown_field':
      return 'Application has an unrecognized required field'
    case 'submission_uncertain':
      return 'Submission status is uncertain'
    case 'account_required':
      return 'Provider requires creating an account'
    default:
      return `Unrecognized blocker ("${category}")`
  }
}
