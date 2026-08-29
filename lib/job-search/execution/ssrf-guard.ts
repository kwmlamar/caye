/**
 * Job-search operator (CAY-194 / #194) — outbound-destination safety guard.
 *
 * Every URL the executor is about to fetch — the initial apply/API URL AND
 * every redirect hop encountered while fetching it — goes through
 * `validateDestination` before a request is made. This is deliberately
 * separate from lib/job-search/policy-gate.ts's `isProhibitedApplyDestination`
 * (LinkedIn/Indeed denylist): that function answers "is this platform one we
 * refuse to automate against at all", this one answers "is this a safe
 * network destination to make a server-side request to right now" —
 * private/loopback/link-local/metadata ranges, non-http(s) schemes, and
 * malformed URLs. Both are checked; either failing stops execution.
 *
 * Known limitation (documented, not silently assumed away): this validates
 * the URL's hostname/IP-literal shape and, for a resolvable hostname,
 * nothing beyond that — it does not pin the resolved IP for the actual
 * TCP connection, so a DNS-rebinding attack (hostname resolves safely at
 * validation time, then to a private IP at connection time) is not fully
 * closed. The realistic exposure here is small: the only host this PR's
 * provider ever connects to is the hardcoded literal
 * `boards-api.greenhouse.io` (never attacker-influenced), and every
 * redirect hop is re-validated against this same guard before being
 * followed. Full DNS-rebinding protection (resolve once, connect to the
 * pinned IP, and validate that IP) would require a custom fetch
 * agent/dispatcher and is flagged as follow-up hardening in the PR
 * description rather than built here.
 */

const PROHIBITED_HOSTNAMES = new Set(['localhost', '0.0.0.0', '::1', '[::1]'])

/** 169.254.169.254 (AWS/GCP/Azure instance metadata) is deliberately called out on top of the general link-local range below, since it is the single highest-value SSRF target. */
const METADATA_IP = '169.254.169.254'

function isIPv4(hostname: string): boolean {
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
}

function ipv4Octets(hostname: string): number[] {
  return hostname.split('.').map((n) => Number(n))
}

/** RFC1918 private ranges, loopback, link-local (incl. cloud metadata), and other reserved ranges a legitimate public ATS host should never resolve to. */
function isPrivateOrReservedIPv4(hostname: string): boolean {
  if (!isIPv4(hostname)) return false
  const [a, b] = ipv4Octets(hostname)
  if (a === undefined || b === undefined || [a, b].some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    // Doesn't parse as a clean four-octet address — treat as unsafe rather
    // than assuming it's a benign hostname format we didn't anticipate.
    return true
  }
  if (a === 127) return true // loopback
  if (a === 10) return true // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true // RFC1918
  if (a === 192 && b === 168) return true // RFC1918
  if (a === 169 && b === 254) return true // link-local, incl. cloud metadata
  if (a === 0) return true // "this network"
  if (a >= 224) return true // multicast/reserved/broadcast
  return false
}

/** IPv6 loopback, unique-local, and link-local ranges. */
function isPrivateOrReservedIPv6(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (h === '::1' || h === '::') return true
  if (h.startsWith('fe80:') || h.startsWith('fe8') || h.startsWith('fe9') || h.startsWith('fea') || h.startsWith('feb')) return true // link-local fe80::/10
  if (h.startsWith('fc') || h.startsWith('fd')) return true // unique-local fc00::/7
  if (h.startsWith('::ffff:')) {
    // IPv4-mapped IPv6 — unwrap and check the embedded IPv4 address.
    const mapped = h.slice('::ffff:'.length)
    if (isIPv4(mapped)) return isPrivateOrReservedIPv4(mapped)
  }
  return false
}

function looksLikeIPv6(hostname: string): boolean {
  return hostname.includes(':')
}

export type DestinationCheck = { allowed: true; hostname: string } | { allowed: false; hostname: string | null; reason: string }

/**
 * The single check every outbound URL (initial request AND every redirect
 * hop) must pass before the executor connects to it. Fails closed on
 * anything unparseable or unrecognized.
 */
export function validateDestination(rawUrl: string): DestinationCheck {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { allowed: false, hostname: null, reason: 'URL could not be parsed.' }
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { allowed: false, hostname: url.hostname || null, reason: `Non-HTTP(S) scheme "${url.protocol}" is never a valid submission destination.` }
  }

  // Embedded credentials. `https://boards-api.greenhouse.io@evil.example/`
  // already fails the host allowlist (URL parsing puts `evil.example` in
  // hostname), but the mirror image — `https://user:pass@boards-api.greenhouse.io/`
  // — passes the allowlist and would silently ship an Authorization header to
  // the ATS. A legitimate ATS URL never carries userinfo; refuse both shapes
  // outright so neither depends on the allowlist catching it.
  if (url.username || url.password) {
    return { allowed: false, hostname: url.hostname || null, reason: 'URL carries embedded credentials (user:pass@) — never a legitimate ATS destination.' }
  }

  // Non-default ports. A real ATS is on 443 (or 80 pre-upgrade). An explicit
  // odd port is either a mistake or an attempt to reach something else on an
  // allowlisted name; either way it is not a destination we submit to.
  if (url.port !== '' && url.port !== '443' && url.port !== '80') {
    return { allowed: false, hostname: url.hostname || null, reason: `Non-standard port ${url.port} is never a valid ATS destination.` }
  }

  // Trailing-dot FQDN ("host.io.") is a distinct string that would miss an
  // exact-match allowlist while resolving identically. Normalize it here so
  // the allowlist sees one canonical form.
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '')

  if (PROHIBITED_HOSTNAMES.has(hostname)) {
    return { allowed: false, hostname, reason: `"${hostname}" is a loopback/local hostname, never a legitimate ATS destination.` }
  }
  if (hostname === METADATA_IP) {
    return { allowed: false, hostname, reason: 'Cloud instance metadata address — refused unconditionally.' }
  }
  if (isIPv4(hostname) && isPrivateOrReservedIPv4(hostname)) {
    return { allowed: false, hostname, reason: `"${hostname}" is a private/reserved IPv4 address.` }
  }
  if (looksLikeIPv6(hostname) && isPrivateOrReservedIPv6(hostname)) {
    return { allowed: false, hostname, reason: `"${hostname}" is a private/reserved IPv6 address.` }
  }
  if (isIPv4(hostname) || looksLikeIPv6(hostname)) {
    // A legitimate ATS host is always a DNS name in this PR's design —
    // never a bare IP literal, even a public one. Treating any IP literal
    // as unsafe by default closes off a whole class of "technically public
    // but definitely not the ATS you meant" destinations.
    return { allowed: false, hostname, reason: 'Bare IP-literal destinations are never allowed; the ATS host must be a DNS name.' }
  }

  return { allowed: true, hostname }
}
