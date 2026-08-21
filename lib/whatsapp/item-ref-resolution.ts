/**
 * Resolving an item_ref has FOUR outcomes, not two.
 *
 * WHY THIS EXISTS (2026-08-07)
 * resolveItemRef (lib/whatsapp/pending.ts) collapses two very different
 * situations into `null`:
 *
 *   a) the operator gave no usable reference       → we must ask which one
 *   b) the operator named something specific that
 *      isn't in the held queue                     → we must say so
 *
 * Both produced the same reply — a bare "Which one did you handle? 1. … / 2. …"
 * — which reads as if Caye simply didn't catch the name. Confirmed live with
 * Bimini: Karenda wrote "Lisa is completed", the classifier correctly extracted
 * item_ref "Lisa Ramos", and Lisa was not a held item (she had no escalation
 * row), so the ref matched nothing. Caye re-listed the queue without ever
 * saying Lisa wasn't in it. Karenda reasonably read that as done and moved on;
 * lisaramos@azamara.com — an Azamara treasury lead waiting on banking details —
 * was never closed, never flagged, and dropped out of both their heads.
 *
 * A miss is information. The operator believes that thread is in the queue and
 * it isn't, which usually means it was never escalated in the first place —
 * exactly the gap they can't see from WhatsApp. Naming it is the whole fix.
 *
 * Kept free of `server-only` and of any pending.ts import so it stays unit
 * testable, mirroring lib/whatsapp/item-ref-guard.ts.
 */

/** Minimal shape needed to resolve and describe a reference. */
export interface ResolvableItem {
  index: number
  contactName: string
}

export type ItemRefOutcome<T> =
  /** Resolved to exactly one item. */
  | { status: 'matched'; item: T }
  /** The queue is empty — there is nothing to act on. */
  | { status: 'no-pending' }
  /** No usable reference and more than one candidate: ask. */
  | { status: 'needs-choice' }
  /** The operator named something that isn't in the queue: say so, then ask. */
  | { status: 'not-found'; ref: string }

/**
 * Same matching rules as resolveItemRef — index, "first"/"last", conversation
 * id, then contact-name substring — but it reports *why* it failed.
 *
 * `idOf` lets callers opt into direct conversation-id matching without this
 * module having to know about PendingHeldItem.
 */
export function resolveItemRefOutcome<T extends ResolvableItem>(
  items: T[],
  ref: string | undefined,
  idOf?: (item: T) => string
): ItemRefOutcome<T> {
  if (items.length === 0) return { status: 'no-pending' }

  if (!ref || !ref.trim()) {
    // A single pending item is unambiguous even with no reference — this is
    // what makes a bare "handled" work after a one-item ping.
    return items.length === 1
      ? { status: 'matched', item: items[0] }
      : { status: 'needs-choice' }
  }

  const trimmed = ref.trim().toLowerCase()

  const asNum = Number(trimmed)
  if (Number.isInteger(asNum) && asNum >= 1 && asNum <= items.length) {
    return { status: 'matched', item: items[asNum - 1] }
  }

  if (trimmed === 'first' || trimmed === 'the first one') {
    return { status: 'matched', item: items[0] }
  }
  if (trimmed === 'last' || trimmed === 'the last one') {
    return { status: 'matched', item: items[items.length - 1] }
  }

  if (idOf) {
    const direct = items.find((it) => idOf(it) === ref)
    if (direct) return { status: 'matched', item: direct }
  }

  const named = items.find((it) => it.contactName.toLowerCase().includes(trimmed))
  if (named) return { status: 'matched', item: named }

  // An out-of-range number ("4" against a 2-item queue) is a miss like any
  // other — the operator pointed at something that isn't there.
  return { status: 'not-found', ref: ref.trim() }
}

/** "1. Ruslan / 2. Jeff A Montenaro" — the choice list both actions present. */
export function formatChoices(items: ResolvableItem[]): string {
  return items.map((p) => `${p.index}. ${p.contactName}`).join(' / ')
}

/**
 * True when a send/edit intent names a target that isn't part of the
 * currently-held queue.
 *
 * WHY THIS EXISTS (CAY-90, 2026-08-18 — Christopher/GGT incident)
 * The legacy dispatch path (send/edit/skip/handled) only ever knows the
 * held queue — it has no access to the back-office agent's conversation
 * memory or its search_threads/get_customer tools. When the operator names
 * a customer already discussed earlier in the SAME conversation but not
 * currently held (nothing pending on their thread right now), the legacy
 * path can only fall back to "which one?" against an unrelated held list —
 * which reads as Caye having lost context it actually still had, just not
 * in a place this path can see. Distinct from `needs-choice` (no reference
 * given at all): that case genuinely has nothing for anyone, agent
 * included, to resolve from a bare ref, so it stays on the legacy ask.
 */
export function namesUnresolvedTarget<T extends ResolvableItem>(
  items: T[],
  ref: string | undefined
): boolean {
  if (!ref || !ref.trim()) return false
  return resolveItemRefOutcome(items, ref).status === 'not-found'
}

/**
 * The operator-facing reply for every non-matched outcome, so `handled` and
 * `skip` phrase a miss identically.
 *
 * `question` is the action's own prompt ("Which one did you handle?").
 */
export function describeUnresolved(
  outcome: Exclude<ItemRefOutcome<ResolvableItem>, { status: 'matched' }>,
  items: ResolvableItem[],
  copy: { nothingPending: string; question: string }
): string {
  if (outcome.status === 'no-pending') return copy.nothingPending
  if (outcome.status === 'not-found') {
    // Lead with the miss. Without this the operator assumes it landed.
    return (
      `I don't see "${outcome.ref}" in the queue — it may never have been ` +
      `escalated to me, so there's nothing on my side to close. ` +
      `${copy.question} ${formatChoices(items)}`
    )
  }
  return `${copy.question} ${formatChoices(items)}`
}
