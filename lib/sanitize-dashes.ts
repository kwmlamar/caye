/**
 * Sanitizes outbound Caye messages by stripping long Unicode dashes according
 * to the human-facing voice rules. Normal ASCII hyphens are preserved.
 */
export function sanitizeDashes(text: string): string {
  if (!text) return text

  // Em dash and horizontal bar used as sentence breaks become a period, then
  // the next Unicode letter is capitalized. If the previous character already
  // ended the sentence, use a space instead to avoid duplicate punctuation.
  let sanitized = text.replace(/(\s*[—―]\s*)([^\p{L}]*)(\p{L}?)/gu, (match, dashPart, nonLetters, letter, offset) => {
    let isPrevSentenceEnding = false
    for (let i = offset - 1; i >= 0; i--) {
      const char = text[i]
      if (/\s/.test(char)) continue
      if (['.', '?', '!'].includes(char)) {
        isPrevSentenceEnding = true
      }
      break
    }

    const replacement = isPrevSentenceEnding ? ' ' : '. '
    const capitalizedLetter = letter ? letter.toUpperCase() : ''
    return replacement + nonLetters + capitalizedLetter
  })

  // Spaced en dashes read more naturally as commas.
  sanitized = sanitized.replace(/\s+–\s+/g, ', ')

  // Any remaining long dashes become normal ASCII hyphens.
  sanitized = sanitized.replace(/[—–―]/g, '-')

  // Cleanup punctuation residue introduced by replacements.
  sanitized = sanitized.replace(/\.{2,}/g, '.')
  sanitized = sanitized.replace(/\s+,/g, ',')

  return sanitized
}
