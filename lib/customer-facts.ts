/**
 * Pure formatter + types for the CUSTOMER FACTS block. Separated from
 * the extraction (lib/contact-profile.ts) so the block rendering can be
 * unit tested without server-only deps and the schema is co-located.
 *
 * Facts are operational truths the customer told us — dietary, mobility,
 * group composition, preferences, occasions. Caye uses them to avoid
 * re-asking and to anticipate needs ("just confirming the booking is
 * still for 4 adults + 1 child?", "we'll note the shellfish allergy").
 */

export interface CustomerFacts {
  /** Dietary restrictions / allergies, short strings. */
  dietary?: string[]
  /** Mobility / accessibility needs. */
  mobility?: string[]
  /** Group composition (e.g. "2 adults + 1 child age 5"). One sentence. */
  group_composition?: string | null
  /** Stated preferences (e.g. "morning tours", "private over group"). */
  preferences?: string[]
  /** Occasions ("anniversary", "honeymoon", "bachelorette"). */
  occasions?: string[]
}

/**
 * True when at least one fact field is populated. Used to decide
 * whether the CUSTOMER FACTS block belongs in the prompt at all.
 */
export function hasFacts(f: CustomerFacts | null | undefined): boolean {
  if (!f) return false
  if (f.dietary && f.dietary.length) return true
  if (f.mobility && f.mobility.length) return true
  if (f.group_composition && f.group_composition.trim()) return true
  if (f.preferences && f.preferences.length) return true
  if (f.occasions && f.occasions.length) return true
  return false
}

/**
 * Render the CUSTOMER FACTS block. Returns empty string when no facts
 * are populated — safe to concatenate unconditionally.
 */
export function formatCustomerFactsBlock(facts: CustomerFacts | null | undefined): string {
  if (!hasFacts(facts)) return ''

  const lines: string[] = []
  if (facts!.dietary && facts!.dietary.length) {
    lines.push(`- Dietary / allergies: ${facts!.dietary.join(', ')}`)
  }
  if (facts!.mobility && facts!.mobility.length) {
    lines.push(`- Mobility / accessibility: ${facts!.mobility.join(', ')}`)
  }
  if (facts!.group_composition && facts!.group_composition.trim()) {
    lines.push(`- Group: ${facts!.group_composition.trim()}`)
  }
  if (facts!.preferences && facts!.preferences.length) {
    lines.push(`- Preferences: ${facts!.preferences.join(', ')}`)
  }
  if (facts!.occasions && facts!.occasions.length) {
    lines.push(`- Occasions noted: ${facts!.occasions.join(', ')}`)
  }

  return (
    'CUSTOMER FACTS — operational truths this customer told us:\n' +
    lines.join('\n') +
    '\n' +
    "Use these to avoid re-asking and to anticipate needs naturally. Don't recite the list " +
    "back to them — work the relevant facts in only where they fit the current message. " +
    "If a fact contradicts what they just said (e.g. previously vegetarian, now mentioning " +
    'steak), trust the new message — facts can be stale.'
  )
}
