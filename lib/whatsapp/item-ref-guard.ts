/**
 * Drops an item_ref the operator never actually gave.
 *
 * WHY THIS EXISTS (2026-08-07)
 * Lamar replied "Yes" to confirm a send the agent had staged for Zanzibar
 * Holidays One. The classifier returned {kind:'send', item_ref:"1"} — and
 * position 1 of the held queue was Oceans Africa, an unrelated cold-outreach
 * lead. Nothing in "Yes" justified "1"; the model invented it.
 *
 * intent.ts ALREADY forbids exactly this — "DO NOT silently default to
 * 'preserve position 1' or any other guess" — but that instruction sits under
 * the BULK + EXCEPTION rules and only governs "all except X" phrasing. The
 * same invention walked straight through the plain send path. Prompt text
 * scoped to one branch isn't a guard; this is the code version, and it covers
 * every action kind at once because it runs on the intent before dispatch.
 *
 * Only the wrong-target case is prevented. Dropping the ref makes the action
 * handlers fall into their existing "Which one?" branch, which is the correct
 * outcome for a genuinely ambiguous confirmation.
 *
 * WHAT COUNTS AS CORROBORATION
 *   - the operator's own text names the item (a standalone number, or a
 *     substring of the contact name), or
 *   - Caye's last message to them was about exactly ONE pending contact, and
 *     the ref points at that contact.
 *
 * The second clause is what keeps a bare "yes please" working after a
 * single-item ping ("Jeff came in — send that?"), which is the behaviour
 * intent.ts's ANSWERING-THE-QUESTION rules exist to produce. It deliberately
 * requires exactly one match: Caye's own disambiguation list ("Which one?
 * 1. Oceans Africa / 2. Eternal Andamans / …") mentions every pending contact
 * and every index, so it corroborates nothing.
 */

export interface ItemRefCandidate {
  index: number
  contactName: string
}

/** Standalone occurrence of a number — "1" matches "send 1" but not "$100". */
function mentionsIndex(text: string, index: number): boolean {
  return new RegExp(`(?<!\\d)${index}(?!\\d)`).test(text)
}

function mentionsName(text: string, contactName: string): boolean {
  const name = contactName.trim().toLowerCase()
  if (!name) return false
  const haystack = text.toLowerCase()
  if (haystack.includes(name)) return true
  // Also accept the leading word of a multi-word business name ("Oceans" for
  // "Oceans Africa"), long enough that it can't collide with filler words.
  const firstWord = name.split(/\s+/)[0]
  return firstWord.length >= 4 && haystack.includes(firstWord)
}

/** True when the operator's own message contains the reference as written. */
function mentionsRef(text: string, ref: string): boolean {
  const trimmed = ref.trim()
  const asNum = Number(trimmed)
  if (Number.isInteger(asNum)) return mentionsIndex(text, asNum)
  return mentionsName(text, trimmed)
}

/** Which pending item an item_ref points at, mirroring resolveItemRef. */
function targetOf(
  items: ItemRefCandidate[],
  ref: string
): ItemRefCandidate | null {
  const trimmed = ref.trim().toLowerCase()
  const asNum = Number(trimmed)
  if (Number.isInteger(asNum) && asNum >= 1 && asNum <= items.length) {
    return items[asNum - 1]
  }
  if (trimmed === 'first' || trimmed === 'the first one') return items[0] ?? null
  if (trimmed === 'last' || trimmed === 'the last one') return items[items.length - 1] ?? null
  return items.find((it) => it.contactName.toLowerCase().includes(trimmed)) ?? null
}

/**
 * Returns the item_ref when the operator actually supplied it, otherwise
 * undefined. `reason` is for logging — it explains a drop, not a keep.
 */
export function corroborateItemRef(input: {
  itemRef: string | undefined
  operatorText: string
  lastOutboundBody: string | null
  pending: ItemRefCandidate[]
}): { itemRef: string | undefined; reason: string | null } {
  const { itemRef, operatorText, lastOutboundBody, pending } = input

  if (!itemRef) return { itemRef: undefined, reason: null }
  // With one item (or none) there is no wrong target to pick.
  if (pending.length <= 1) return { itemRef, reason: null }

  // Did the operator say this reference themselves? Checked against the RAW
  // ref, before resolution, because a ref naming a thread that isn't in the
  // queue MUST survive this guard: item-ref-resolution.ts turns that into
  // "Lisa isn't in the held queue" instead of a bare re-list, and dropping it
  // here would collapse it back into "which one?" — undoing that fix.
  if (mentionsRef(operatorText, itemRef)) return { itemRef, reason: null }

  const target = targetOf(pending, itemRef)
  if (!target) {
    // Names nothing pending AND nothing the operator typed — invented.
    return { itemRef: undefined, reason: `item_ref "${itemRef}" matches no pending item` }
  }

  // The operator said it themselves.
  if (mentionsIndex(operatorText, target.index) || mentionsName(operatorText, target.contactName)) {
    return { itemRef, reason: null }
  }

  // Or Caye's last message was unambiguously about this one contact.
  if (lastOutboundBody) {
    const named = pending.filter((p) => mentionsName(lastOutboundBody, p.contactName))
    if (named.length === 1 && named[0].index === target.index) {
      return { itemRef, reason: null }
    }
  }

  return {
    itemRef: undefined,
    reason: `item_ref "${itemRef}" (${target.contactName}) not corroborated by the operator's message`,
  }
}
