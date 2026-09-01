/**
 * Final human-facing cleanup for Caye text.
 *
 * Models are instructed not to use long dashes, but prompt instructions are
 * not a delivery guarantee. Keep this deterministic sanitizer at outbound
 * boundaries too.
 */
export function sanitizeDashes(text: string): string {
  if (!text) return text

  // Turn clause-separating em dashes and horizontal bars into a clean
  // sentence break. If punctuation already ended the sentence, just add a
  // space. Capitalize the next letter when there is one.
  let sanitized = text.replace(/(\s*[—―]\s*)([^\p{L}]*)(\p{L}?)/gu, (_match, _dashPart, nonLetters, letter, offset) => {
    let isPrevSentenceEnding = false
    for (let i = offset - 1; i >= 0; i--) {
      const char = text[i]
      if (/\s/.test(char)) continue
      if (['.', '?', '!'].includes(char)) isPrevSentenceEnding = true
      break
    }

    const replacement = isPrevSentenceEnding ? ' ' : '. '
    return replacement + nonLetters + (letter ? letter.toUpperCase() : '')
  })

  // A spaced en dash usually separates phrases. A comma keeps the thought
  // compact without letting a long dash reach a human.
  sanitized = sanitized.replace(/\s+–\s+/g, ', ')

  // Any remaining long-dash character is replaced with a normal hyphen.
  // This catches numeric ranges and tightly joined text.
  sanitized = sanitized.replace(/[—–―]/g, '-')

  sanitized = sanitized.replace(/\.{2,}/g, '.')
  sanitized = sanitized.replace(/\s+,/g, ',')

  return sanitized
}
