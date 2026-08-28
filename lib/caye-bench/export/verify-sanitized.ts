import type { ReplayTrace } from '../replay/types'

/**
 * export/verify-sanitized.ts — the fail-closed check.
 *
 * `sanitizeRawTrace` (replay/sanitize.ts, unmodified) is the primary
 * redaction pass. This is a SEPARATE, independent re-scan of its OUTPUT
 * — deliberately not trusting that sanitization succeeded just because
 * it ran without throwing. Walks every string value in the trace
 * looking for residual PII patterns and structural red flags. If
 * anything is found, `verifySanitizedTrace` returns `safe: false` and
 * `capture.ts` refuses to let the trace become eligible for
 * `--preview`/`--save` — "fail closed if sanitization cannot establish
 * that an export is safe," not "warn and continue."
 *
 * This is defense in depth, not a replacement for `sanitizeRawTrace`
 * doing its job correctly — a regex scan can miss PII that doesn't look
 * like an email/phone/known name (a street address, a boat's registration
 * number, a distinctive turn of phrase). Treat a clean result as "no
 * KNOWN red flags," not "provably anonymous."
 */

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g
const PHONE_RE = /\+?\d[\d\-\s().]{7,}\d/g
/** A bare UUID (36 hex+dash chars) is a raw database id — every real
 *  identifier in a ReplayTrace must already be a `role_<10-hex>`
 *  pseudonym or an `entitytype-<n>` synthetic id (see build-raw-trace.ts);
 *  a surviving UUID means something skipped pseudonymization. */
const RAW_UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const STRIPE_KEY_RE = /\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{10,}\b/g
const CREDENTIAL_KEY_PATTERN = /(password|secret|token|api[_-]?key|salt)/i

export interface SanitizationIssue {
  path: string
  reason: string
  sample: string
}

export interface VerifySanitizedResult {
  safe: boolean
  issues: SanitizationIssue[]
}

function truncate(s: string, max = 80): string {
  return s.length > max ? `${s.slice(0, max)}…` : s
}

function scanString(path: string, value: string, issues: SanitizationIssue[]): void {
  const email = value.match(EMAIL_RE)
  if (email) issues.push({ path, reason: 'looks like an email address', sample: truncate(email[0]) })
  const phone = value.match(PHONE_RE)
  if (phone) issues.push({ path, reason: 'looks like a phone number', sample: truncate(phone[0]) })
  const uuid = value.match(RAW_UUID_RE)
  if (uuid) issues.push({ path, reason: 'looks like an un-pseudonymized raw UUID', sample: truncate(uuid[0]) })
  const stripeKey = value.match(STRIPE_KEY_RE)
  if (stripeKey) issues.push({ path, reason: 'looks like a Stripe API key', sample: '[redacted-in-report]' })
}

function walk(value: unknown, path: string, issues: SanitizationIssue[]): void {
  if (typeof value === 'string') {
    scanString(path, value, issues)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => walk(v, `${path}.${i}`, issues))
    return
  }
  if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) {
      if (CREDENTIAL_KEY_PATTERN.test(key)) {
        issues.push({ path: `${path}.${key}`, reason: `field name "${key}" suggests a credential/secret — must never appear on a trace at all`, sample: '[withheld]' })
        continue
      }
      walk(v, `${path}.${key}`, issues)
    }
  }
}

export function verifySanitizedTrace(trace: ReplayTrace): VerifySanitizedResult {
  const issues: SanitizationIssue[] = []

  if (!trace.sanitizedAt) issues.push({ path: 'sanitizedAt', reason: 'missing — trace does not look like it went through sanitizeRawTrace', sample: '' })
  if (!trace.provenance?.redactionMethod) issues.push({ path: 'provenance.redactionMethod', reason: 'missing — sanitization provenance not recorded', sample: '' })
  if (!/^[a-z]+_[0-9a-f]{10}$/.test(trace.workspaceId)) {
    issues.push({ path: 'workspaceId', reason: 'workspace id does not match the expected pseudonym shape', sample: trace.workspaceId })
  }

  // Actor pseudonyms must match `${role}_${10 hex chars}` — a raw phone
  // number or email accidentally left in `actor.id` would fail this.
  for (const actor of trace.actors) {
    if (!/^[a-z]+_[0-9a-f]{10}$/.test(actor.id)) {
      issues.push({ path: `actors.id=${actor.id}`, reason: 'actor id does not match the expected pseudonym shape', sample: actor.id })
    }
  }

  walk(trace.events, 'events', issues)
  walk(trace.seed, 'seed', issues)
  walk(trace.historicalEffects, 'historicalEffects', issues)
  walk({ sourceDescription: trace.sourceDescription, notes: trace.provenance?.notes }, 'freeText', issues)

  return { safe: issues.length === 0, issues }
}
