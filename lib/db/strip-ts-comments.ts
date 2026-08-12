/**
 * strip-ts-comments.ts
 *
 * Blanks out comments in TypeScript source before scanning it for literals
 * that get written to the database.
 *
 * WHY (2026-08-12)
 * The db-literal guards match `column: 'value'` anywhere in a .ts file,
 * including inside comments. So documenting the bug trips the guard for the
 * bug: writing
 *
 *   //   sender_type: 'system'   — 100% failure since it shipped
 *
 * in a doc comment failed `only writes valid sender_type values`. The whole
 * value of these guards is that a failure means something real; a guard that
 * fires on its own documentation teaches people to add exceptions to it,
 * and an exception list is how the original gaps survived for weeks.
 *
 * A literal in a comment is never written to the database — including in
 * commented-out code, which does not run.
 *
 * Comments are replaced with spaces rather than deleted so byte offsets are
 * preserved and the guards keep reporting correct line numbers.
 */

/**
 * Replace `//` and block comments with equivalent whitespace.
 *
 * Written as a character scanner rather than a regex because the cases that
 * matter are exactly the ones regexes get wrong: `'https://x'` is a string
 * containing slashes, not a comment, and `'/*'` inside a string does not open
 * one. Template literals are tracked too, since prompt strings in this repo
 * are full of both.
 */
export function stripTsComments(source: string): string {
  const out = source.split('')
  let i = 0
  const n = source.length

  while (i < n) {
    const ch = source[i]
    const next = source[i + 1]

    // String and template literals: skip to the closing delimiter.
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      i++
      while (i < n) {
        if (source[i] === '\\') { i += 2; continue }
        if (source[i] === quote) { i++; break }
        i++
      }
      continue
    }

    if (ch === '/' && next === '/') {
      while (i < n && source[i] !== '\n') { out[i] = ' '; i++ }
      continue
    }

    if (ch === '/' && next === '*') {
      out[i] = ' '
      out[i + 1] = ' '
      i += 2
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        // Keep newlines so line numbers survive.
        if (source[i] !== '\n') out[i] = ' '
        i++
      }
      if (i < n) { out[i] = ' '; out[i + 1] = ' '; i += 2 }
      continue
    }

    i++
  }

  return out.join('')
}
