/**
 * The single answer to "what do we actually know about this customer?"
 *
 * WHY THIS EXISTS (2026-08-08)
 * Contact details live in four places and no two tools read the same subset:
 *
 *   unified_conversations.customer_id  the channel-native address a thread
 *                                      arrives on — the thing we actually
 *                                      send to
 *   contacts.email / .phone_number     present for 62% of Bimini threads,
 *                                      93% on one workspace, and 0% on the
 *                                      outreach workspace
 *   conversation metadata intake       what the customer typed into a form
 *   operator statements                "her real number is …"
 *
 * get_customer read customer_id and inferred an email from it. Live result:
 *
 *   Lamar: "whats zanzibar email"
 *   Caye:  "I don't have it — their thread has no email address stored."
 *
 * It was zanzi2go@gmail.com, in the column the send had used minutes earlier.
 *
 * The deeper trap is a naming collision: `customer_id` means the WORKSPACE in
 * `contacts` and the CUSTOMER'S ADDRESS in `unified_conversations`. Both
 * readings look reasonable in isolation. This module exists so tool code never
 * has to make that call — it takes raw rows and returns one shaped answer.
 *
 * DELIBERATELY PURE. No DB access, no `server-only`. Every rule here is
 * exercised against fixtures captured from real production rows
 * (customer-profile.golden.test.ts), because the failure mode is a stub that
 * agrees with its author while Postgres disagrees.
 */

import { isNoReplySender } from '../sender-classifier'

/**
 * What kind of thing an address is. Learned from real rows, not invented:
 *
 * - direct    a real address a human reads. The only kind worth answering
 *             "what's their email?" with.
 * - relay     a transport artifact. Bimini's Wix contact form mints a fresh
 *             `<uuid>@crm.wix.com` (or `reply-to+<hash>@crm.wix.com`) PER
 *             SUBMISSION, so Charity Williams appears as three different
 *             "people" who are one person, and none of those strings is her
 *             email. Replies to a relay do reach her, so it stays sendable —
 *             but reporting it as her address is worse than saying we
 *             don't have one.
 * - automated no human at all: mailer-daemon, postmaster, noreply. These
 *             already have contacts rows in production; they must never be
 *             created, counted, or offered as a customer.
 */
export type AddressKind = 'direct' | 'relay' | 'automated'

/**
 * How we came to believe an address. Never collapsed into a single "best"
 * value — an intake address differing from the thread address is usually the
 * useful signal (a typo, or an agent booking on someone else's behalf).
 */
export type Provenance =
  /** We have exchanged real messages at this address. */
  | 'verified'
  /** An operator told us. */
  | 'stated'
  /** The customer typed it into a form; never confirmed by a message. */
  | 'claimed'

export interface Identity {
  channel: string
  address: string
  kind: AddressKind
  provenance: Provenance
  last_seen: string | null
}

/** Relay/forwarder patterns. Conservative on purpose: a false 'relay' hides a
 *  real address, which is the bug this module exists to fix. Only shapes
 *  observed in production are listed. */
const RELAY_PATTERNS: RegExp[] = [
  /@crm\.wix\.com$/i,
  /^reply-to\+/i,
  /@reply\./i,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@/i,
]

export function classifyAddress(address: string | null | undefined): AddressKind | null {
  const value = address?.trim()
  if (!value) return null
  if (isNoReplySender(value)) return 'automated'
  if (RELAY_PATTERNS.some((re) => re.test(value))) return 'relay'
  return 'direct'
}

/**
 * A thread's channel-native id, split into the contact detail it represents.
 * Messenger/Instagram ids are page-scoped opaque strings — they identify a
 * person but are not an address a human can act on, so both fields stay null
 * rather than presenting an id as a phone number.
 */
export function identityFromConversation(
  channelType: string | null,
  customerId: string | null,
  lastSeen: string | null = null
): Identity | null {
  const value = customerId?.trim()
  if (!value) return null

  const looksLikeEmail = value.includes('@')
  if (!looksLikeEmail && channelType !== 'whatsapp') return null

  const kind = classifyAddress(value)
  if (!kind) return null

  return {
    channel: looksLikeEmail ? 'email' : 'whatsapp',
    address: value,
    kind,
    provenance: 'verified',
    last_seen: lastSeen,
  }
}

/** Build an identity from a stored contacts row or an intake form field. */
export function identityFromField(
  channel: 'email' | 'whatsapp',
  value: string | null | undefined,
  provenance: Provenance,
  lastSeen: string | null = null
): Identity | null {
  const address = value?.trim()
  if (!address) return null
  const kind = classifyAddress(address)
  if (!kind) return null
  return { channel, address, kind, provenance, last_seen: lastSeen }
}

/**
 * Collapse identities that are literally the same address.
 *
 * This is the ONLY automatic merge. Name similarity never merges: Bimini has
 * three "Charity Williams" rows and two "Kim"s, and joining people by name
 * would show one customer another's history. Cross-channel joins are an
 * explicit operator action, not an inference.
 *
 * When the same address arrives with different provenance, the strongest wins
 * (verified > stated > claimed) and the most recent last_seen is kept.
 */
const PROVENANCE_RANK: Record<Provenance, number> = { verified: 3, stated: 2, claimed: 1 }

export function mergeIdentities(identities: (Identity | null)[]): Identity[] {
  const byAddress = new Map<string, Identity>()
  for (const identity of identities) {
    if (!identity) continue
    const key = `${identity.channel}:${identity.address.toLowerCase()}`
    const existing = byAddress.get(key)
    if (!existing) {
      byAddress.set(key, identity)
      continue
    }
    byAddress.set(key, {
      ...existing,
      provenance:
        PROVENANCE_RANK[identity.provenance] > PROVENANCE_RANK[existing.provenance]
          ? identity.provenance
          : existing.provenance,
      last_seen:
        (identity.last_seen ?? '') > (existing.last_seen ?? '')
          ? identity.last_seen
          : existing.last_seen,
    })
  }
  return [...byAddress.values()].sort(
    (a, b) =>
      PROVENANCE_RANK[b.provenance] - PROVENANCE_RANK[a.provenance] ||
      (b.last_seen ?? '').localeCompare(a.last_seen ?? '')
  )
}

/**
 * What a tool reports about how to reach someone.
 *
 * `absent` and `not_checked` are the load-bearing fields. Three times in one
 * night Caye asserted a false negative — "we already sent this", "I don't have
 * their email" — because a null carried no distinction between "looked
 * everywhere, genuinely missing" and "this call never fetched that". A field
 * appears in exactly one of: a populated list, `absent`, or `not_checked`.
 */
export interface ContactReachability {
  emails: Identity[]
  phones: Identity[]
  /** Addresses that reach them but are not their own (see AddressKind.relay). */
  relay_only: Identity[]
  absent: string[]
  not_checked: string[]
}

export interface ReachabilityOptions {
  /** Fields this call actually looked for. Anything omitted is reported as
   *  not_checked rather than silently absent. */
  checked?: ('email' | 'phone')[]
}

export function summarizeReachability(
  identities: Identity[],
  options: ReachabilityOptions = {}
): ContactReachability {
  const checked = options.checked ?? ['email', 'phone']
  const usable = identities.filter((i) => i.kind === 'direct')

  const emails = usable.filter((i) => i.channel === 'email')
  const phones = usable.filter((i) => i.channel === 'whatsapp')
  const relayOnly = identities.filter((i) => i.kind === 'relay')

  const absent: string[] = []
  const notChecked: string[] = []

  if (!checked.includes('email')) notChecked.push('email')
  else if (emails.length === 0) absent.push('email')

  if (!checked.includes('phone')) notChecked.push('phone')
  else if (phones.length === 0) absent.push('phone')

  return { emails, phones, relay_only: relayOnly, absent, not_checked: notChecked }
}

/**
 * Whether a set of candidate matches can be answered as one customer.
 *
 * An ambiguous result deliberately carries NO primary. Handing the model a
 * ranked list and a rule to ask is the shape that already failed tonight: the
 * intent classifier, given candidates and no constraint in code, answered a
 * bare "Yes" with item_ref "1" and targeted an unrelated contact. If there is
 * nothing to latch onto, it cannot latch onto the wrong one.
 */
export type MatchOutcome<T> =
  | { match: 'none' }
  | { match: 'unique'; contact: T }
  | { match: 'ambiguous'; candidates: T[] }

export function classifyMatch<T>(candidates: T[]): MatchOutcome<T> {
  if (candidates.length === 0) return { match: 'none' }
  if (candidates.length === 1) return { match: 'unique', contact: candidates[0] }
  return { match: 'ambiguous', candidates }
}

/**
 * Should this thread's party become a contact at all?
 *
 * Gate for lazy materialization. Production already carries contacts rows for
 * mailer-daemon@mail.zoho.com and mailer-daemon@googlemail.com — created
 * before any such gate existed. 27% of all threads (196 of 729) are
 * daemon/no-reply traffic; without this, "how many customers do we have?"
 * is wrong by a quarter.
 */
export function isRealCorrespondent(channelType: string | null, customerId: string | null): boolean {
  const identity = identityFromConversation(channelType, customerId)
  if (!identity) return false
  return identity.kind !== 'automated'
}
