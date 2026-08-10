/**
 * How a guest gets named in anything an operator reads.
 *
 * Pure, so it unit-tests without server-only deps — same pattern as
 * autosend-gate.ts.
 *
 * WHY THIS EXISTS (2026-08-09)
 * Every applyEscalation call site passes `contactName: effectiveName ||
 * effectiveEmail`. When an inbound email carries no display name, that
 * fallback is a raw address — so the escalation ping to Mrs. Max read
 * "tuzi needs your call" about a guest she had spent the previous forty
 * minutes discussing as Delysia Weeks. From the owner's side that is not a
 * cosmetic wart; it reads as a second, unrelated person appearing in the
 * queue while she is mid-decision on the first.
 *
 * An email address is an identifier, not a name. Prefer a real name from
 * anywhere we have one; otherwise say "a guest" and let the contact details
 * elsewhere in the ping do the identifying work.
 */

/** True when a string is an email address rather than a person's name. */
export function looksLikeEmailAddress(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
}

/**
 * Best operator-facing name from the candidates available at a call site,
 * in preference order. Skips blanks and anything that is really an email
 * address. Returns 'A guest' when nothing usable is left.
 */
export function displayContactName(...candidates: (string | null | undefined)[]): string {
  for (const candidate of candidates) {
    const trimmed = candidate?.trim()
    if (!trimmed) continue
    if (looksLikeEmailAddress(trimmed)) continue
    return trimmed
  }
  return 'A guest'
}
