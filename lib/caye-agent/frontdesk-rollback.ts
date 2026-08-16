/**
 * frontdesk-rollback.ts (2026-08-16, global Zoho cutover)
 *
 * ONE emergency rollback seam for the converged front-desk runtime — not a
 * feature-flag platform, just a single env var read in one place.
 *
 * Default is ON (converged runtime handles eligible Zoho front-desk email).
 * Set `CAYE_CONVERGED_FRONTDESK_ENABLED=false` in the deployment
 * environment to instantly revert every workspace to the legacy
 * `generateCayeAutoReply` path — no code deploy, no migration, no data
 * change. The persistence schema (`caye_frontdesk_agent_turns`,
 * `caye_pending_actions.superseded_by`) stays in place, unused, when
 * disabled; nothing needs to be cleaned up to roll back.
 */
export function convergedFrontDeskEnabled(): boolean {
  return process.env.CAYE_CONVERGED_FRONTDESK_ENABLED !== 'false'
}
