/**
 * Job-search operator (CAY-194 / #194) — redirect-revalidating fetch.
 *
 * "Do NOT validate only the initial apply URL — revalidate every
 * meaningful navigation destination." fetch() follows redirects
 * transparently by default, which would silently hand control of the next
 * hop to whatever the ATS/employer server returns. This wrapper always
 * fetches with `redirect: 'manual'` and re-runs the full destination
 * check (ssrf-guard + an allowlist predicate the caller supplies) on every
 * Location header before following it, capped at MAX_REDIRECTS hops.
 */
import { validateDestination } from './ssrf-guard'
import type { DomainValidation } from './types'

const MAX_REDIRECTS = 3
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

export type SafeFetchResult =
  | { outcome: 'response'; response: Response; domainValidations: DomainValidation[] }
  | { outcome: 'blocked'; reason: string; domainValidations: DomainValidation[] }
  | { outcome: 'too_many_redirects'; domainValidations: DomainValidation[] }

/**
 * @param isAllowedHost additional allowlist check beyond the generic SSRF/private-range guard (e.g. "must stay within Greenhouse's own hosts").
 */
export async function safeFetch(
  initialUrl: string,
  init: RequestInit,
  isAllowedHost: (hostname: string) => boolean,
): Promise<SafeFetchResult> {
  const domainValidations: DomainValidation[] = []
  let currentUrl = initialUrl

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const destination = validateDestination(currentUrl)
    const hostAllowed = destination.allowed && isAllowedHost(destination.hostname)
    domainValidations.push({
      url: currentUrl,
      hostname: destination.allowed ? destination.hostname : destination.hostname,
      allowed: hostAllowed,
      reason: destination.allowed ? (hostAllowed ? 'Allowed host.' : 'Host is network-safe but not on the provider allowlist.') : destination.reason,
    })
    if (!hostAllowed) {
      return { outcome: 'blocked', reason: domainValidations[domainValidations.length - 1].reason, domainValidations }
    }

    const response = await fetch(currentUrl, { ...init, redirect: 'manual' })

    if (!REDIRECT_STATUSES.has(response.status)) {
      return { outcome: 'response', response, domainValidations }
    }

    const location = response.headers.get('location')
    if (!location) {
      // A redirect status with no Location header is malformed — treat the
      // response itself as the terminal one rather than guessing a target.
      return { outcome: 'response', response, domainValidations }
    }
    currentUrl = new URL(location, currentUrl).toString()
  }

  return { outcome: 'too_many_redirects', domainValidations }
}
