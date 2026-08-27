/**
 * The one-line "Caye speaks first" sentence at the top of SnapshotCard —
 * built from real, already-fetched command-overview/today-stats numbers,
 * never invented copy. Deliberately a template, not a model call: this is
 * the documented interim step toward the future "Caye picks her own
 * presentation" direction (see SnapshotCard's doc comment), not that
 * system itself. No LLM spend or call-count figures belong here — that's
 * internal economics, not something the founder's own employee reports
 * about herself in the daily brief.
 */

export interface BriefingInputs {
  bookingsCount: number
  customersAnswered: number
  /** Name of the single most pressing open item, if any (e.g. a customer name). */
  primaryAttentionName: string | null
  /** How many additional open items exist beyond the primary one. */
  additionalAttentionCount: number
}

export function buildBriefingLine(input: BriefingInputs): string | null {
  const { bookingsCount, customersAnswered, primaryAttentionName, additionalAttentionCount } = input

  const facts: string[] = []
  if (customersAnswered > 0) facts.push(`I handled ${customersAnswered} customer${customersAnswered === 1 ? '' : 's'} today`)
  if (bookingsCount > 0) facts.push(`you have ${bookingsCount} booking${bookingsCount === 1 ? '' : 's'} this week`)

  const hasAttention = primaryAttentionName !== null
  if (facts.length === 0 && !hasAttention) return null

  let line = facts.length > 0 ? `Morning. ${facts.join(' and ')}.` : 'Morning.'

  if (hasAttention) {
    const totalAttention = 1 + additionalAttentionCount
    line += totalAttention === 1
      ? ` ${primaryAttentionName} is the only thing that actually needs you.`
      : ` ${primaryAttentionName} and ${additionalAttentionCount} other${additionalAttentionCount === 1 ? '' : 's'} need you.`
  }

  return line
}
