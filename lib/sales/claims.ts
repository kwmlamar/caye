/**
 * claims.ts
 *
 * Post-generation truthfulness check for anything Caye is about to say to a
 * prospect. Fails closed: a draft that trips any rule is not sent, it is
 * held for Lamar.
 *
 * WHY (2026-08-12)
 * `outreach-draft-guard.ts` already checks STYLE (banned hedge phrases,
 * unfilled `[First Name]` placeholders). Nothing checked TRUTH. With
 * autonomous sending there is no human between an invented price and a real
 * prospect's inbox, and the cost of "Caye told a prospect we integrate with
 * QuickBooks" is not a bad email, it is a refund and a reputation.
 *
 * The design principle is the same as lib/caye-agent/evidence.ts: the model
 * does not get to vouch for itself. Facts authorise; generated text is
 * checked against them afterwards by code that cannot be talked out of it.
 *
 * Scope note: this catches *checkable* fabrications — numbers, names,
 * integrations, absolutes. It cannot catch a plausible-sounding invented
 * sentence with no checkable token in it, and pretending otherwise would be
 * its own kind of dishonesty. It raises the floor; it is not a proof of
 * truthfulness.
 */

import { SALES_FACTS, type SalesFacts } from './facts'

export type ClaimIssueKind =
  | 'unverified_price'
  | 'unnameable_customer'
  | 'unsupported_integration'
  | 'nonexistent_capability'
  | 'fabricated_scale'
  | 'unauthorised_commitment'

export interface ClaimIssue {
  kind: ClaimIssueKind
  /** The exact offending text, for the operator note. */
  match: string
}

/** Any money figure. */
const MONEY_RE = /\$\s?(\d[\d,]*)(?:\.(\d{2}))?/g

/**
 * Claims about how many customers we have. Every one of these is a lie
 * while the real number is 1, and they are the most tempting thing for a
 * sales model to reach for.
 */
const SCALE_RE =
  /\b(hundreds|thousands|dozens|many businesses|lots of businesses|\d{2,}\s+(?:businesses|customers|clients|operators))\b/gi

/**
 * Promises only Lamar can make. Caye offering a discount or a custom
 * contract is not a tone problem, it is an unauthorised commitment that a
 * prospect may reasonably hold us to.
 */
const COMMITMENT_RE =
  /\b(i can (?:offer|give|do) you|special (?:price|rate|deal)|discount|free (?:month|trial period)|money.back guarantee|we guarantee|custom (?:plan|pricing|contract)|waive|refund)\b/gi

/** Integration/capability verbs paired with a named third party. */
const INTEGRATION_RE =
  /\b(?:integrat\w*|connect\w*|sync\w*|works? with)\s+(?:with\s+|to\s+)?(quickbooks|xero|stripe|square|shopify|calendly|hubspot|salesforce|mailchimp|zapier|sms|twilio|slack)\b/gi

function normalise(s: string): string {
  return s.toLowerCase().trim()
}

/**
 * @param text  the draft as it would be sent
 * @param facts inject in tests; defaults to live product truth
 */
export function findClaimIssues(text: string, facts: SalesFacts = SALES_FACTS): ClaimIssue[] {
  const issues: ClaimIssue[] = []

  // Price: any figure that is not the current published standard price.
  for (const m of text.matchAll(MONEY_RE)) {
    const dollars = Number(m[1].replace(/,/g, ''))
    if (!Number.isFinite(dollars)) continue
    if (dollars !== facts.monthlyPriceUsd) {
      issues.push({ kind: 'unverified_price', match: m[0] })
    }
  }

  // Named customers. Only flags names that look like a customer claim; a
  // bare place name is not enough, since "Bimini" is also a location.
  const nameable = facts.nameableCustomers.map(normalise)
  const CUSTOMER_CLAIM_RE =
    /\b(?:like|such as|including|for example|e\.g\.?)\s+([A-Z][\w&'-]*(?:\s+[A-Z][\w&'-]*){0,3})/g
  for (const m of text.matchAll(CUSTOMER_CLAIM_RE)) {
    const named = normalise(m[1])
    if (named.length < 3) continue
    const allowed = nameable.some((c) => c.includes(named) || named.includes(c))
    if (!allowed) issues.push({ kind: 'unnameable_customer', match: m[1] })
  }

  for (const m of text.matchAll(SCALE_RE)) {
    issues.push({ kind: 'fabricated_scale', match: m[0] })
  }

  for (const m of text.matchAll(COMMITMENT_RE)) {
    issues.push({ kind: 'unauthorised_commitment', match: m[0] })
  }

  for (const m of text.matchAll(INTEGRATION_RE)) {
    const named = normalise(m[1])
    const supported = facts.supportedChannels.some((c) => normalise(c) === named)
    if (!supported) issues.push({ kind: 'unsupported_integration', match: m[0] })
  }

  // Capabilities we know we do not have, asserted POSITIVELY. The negative
  // lookahead is load-bearing: "she does not do phone answering yet" has to
  // stay sayable, because answering "no, not yet" honestly is exactly the
  // behaviour this guard exists to protect. Only an affirmative claim is an
  // issue.
  for (const missing of facts.notBuilt) {
    const head = missing.split(/[/ ]/)[0]
    if (head.length < 4) continue
    const affirmative = new RegExp(
      `\\b(?:she|caye|it|we)\\s+(?:can|does|do|handles?|supports?|will)\\b` +
        `(?!\\s*(?:not\\b|never\\b|n't|'t))` +
        `\\s+[^.!?]{0,40}\\b${escapeRe(head)}`,
      'i'
    )
    const m = text.match(affirmative)
    if (m) issues.push({ kind: 'nonexistent_capability', match: m[0] })
  }

  return issues
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Operator-readable rejection text, mirroring describeDraftIssues. */
export function describeClaimIssues(issues: ClaimIssue[]): string {
  const label: Record<ClaimIssueKind, string> = {
    unverified_price: `a price that is not $${SALES_FACTS.monthlyPriceUsd}`,
    unnameable_customer: 'a customer we cannot name',
    unsupported_integration: 'an integration that does not exist',
    nonexistent_capability: 'a capability that is not built',
    fabricated_scale: 'an overstated number of customers',
    unauthorised_commitment: 'a commitment Caye cannot authorise',
  }
  return issues.map((i) => `${label[i.kind]} ("${i.match.trim()}")`).join('; ')
}
