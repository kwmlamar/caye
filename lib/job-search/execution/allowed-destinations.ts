/**
 * Job-search operator (CAY-194 / #194) — provider host allowlist.
 *
 * Distinct from ssrf-guard.ts (which rejects dangerous destination
 * *shapes* — private IPs, localhost, non-http schemes) and from
 * policy-gate.ts's isProhibitedApplyDestination (which rejects LinkedIn/
 * Indeed specifically). This is the third, narrowest check: even a public,
 * non-prohibited, non-private hostname is only a valid submission
 * destination if it is one of the exact hosts a supported provider
 * executor actually talks to. A Greenhouse-sourced candidate whose apply
 * URL somehow points somewhere else (compromised feed, malformed data,
 * unexpected redirect) must never be treated as "close enough."
 */

export const ALLOWED_ATS_HOSTS: Record<string, readonly string[]> = {
  greenhouse: [
    'boards.greenhouse.io',
    'job-boards.greenhouse.io',
    'job-boards.eu.greenhouse.io',
    'boards-api.greenhouse.io',
  ],
  // Lever's hosted application form lives entirely on this one host across
  // every employer (verified against live jobs.lever.co apply pages for two
  // unrelated employers on 2026-08-31) — there is no separate API host
  // analogous to Greenhouse's boards-api.greenhouse.io, because Lever's
  // hosted form has no public field-discovery API at all (see
  // providers/lever-form-session.ts).
  lever: ['jobs.lever.co'],
}

export function isAllowedAtsHost(provider: string, hostname: string): boolean {
  const hosts = ALLOWED_ATS_HOSTS[provider]
  if (!hosts) return false
  const lower = hostname.toLowerCase()
  return hosts.some((h) => lower === h)
}

/** Every host any supported provider is allowed to reach, flattened — used to validate a redirect hop without yet knowing which provider "owns" it. */
export function isAnyAllowedAtsHost(hostname: string): boolean {
  const lower = hostname.toLowerCase()
  return Object.values(ALLOWED_ATS_HOSTS).some((hosts) => hosts.some((h) => lower === h))
}
