/**
 * Sanitizes outbound Caye messages by stripping em-dashes and en-dashes
 * according to Lamar's business voice rules.
 */
export function sanitizeDashes(text: string): string {
  if (!text) return text

  // 1. \s*—\s* (em-dash, U+2014) -> ". " then capitalize the next Unicode letter
  // If the prior non-whitespace character was already sentence-ending (. ? !),
  // we replace the dash with a space " " instead of ". " to avoid duplicate punctuation.
  let sanitized = text.replace(/(\s*—\s*)([^\p{L}]*)(\p{L}?)/gu, (match, dashPart, nonLetters, letter, offset) => {
    // Find the character before the match (ignoring whitespace)
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

  // 2. \s+–\s+ (en-dash, U+2013, surrounded by spaces) -> ", "
  sanitized = sanitized.replace(/\s+–\s+/g, ', ')

  // 3 & 4. remaining em-dashes / en-dashes -> "-"
  sanitized = sanitized.replace(/—/g, '-')
  sanitized = sanitized.replace(/–/g, '-')

  // 5. Cleanup residue: collapse ".." -> "." and " ," -> ","
  sanitized = sanitized.replace(/\.{2,}/g, '.')
  sanitized = sanitized.replace(/\s+,/g, ',')

  return sanitized
}
