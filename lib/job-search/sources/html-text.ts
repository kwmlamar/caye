/**
 * Job-search operator (#192) — shared HTML-to-text extraction for source
 * adapters (CAY-192 audit, PR #196).
 *
 * Both Greenhouse's `content` field and Lever's `lists[].content` field
 * are HTML. Verified live against real API responses (2026-08-28):
 *
 *   - Greenhouse's `content` (boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true)
 *     comes back HTML-entity-encoded, and in practice DOUBLE-encoded —
 *     e.g. a live GitLab posting's raw JSON contains the sequence
 *     `&lt;strong&gt;`, which JSON-decodes to the literal text
 *     `&lt;strong&gt;`, not an actual `<strong>` tag. A naive
 *     `/<[^>]+>/g` tag-stripping regex (what this file replaced) matches
 *     nothing on that text — it's a complete no-op on real data, so raw
 *     `&lt;...&gt;` markup and doubly-encoded entities like `&amp;nbsp;`
 *     flow unchanged into detectWorkAuthSignals/parseYearsRequired/etc.
 *     `&amp;nbsp;` in particular glues two words together with zero real
 *     whitespace between them (e.g. "values&amp;nbsp;and" has no space
 *     byte at all), which can silently break a multi-word policy-gate
 *     pattern that relies on `\s+` between tokens.
 *   - Lever's `lists[].content` (api.lever.co/v0/postings/{site}) is
 *     single-encoded real HTML (literal `<div>`, `<li>` tags), also with
 *     `&nbsp;`/`&amp;` entities mixed in.
 *
 * decodeHtmlEntities() repeatedly decodes (bounded, stops once a pass is a
 * no-op) so it transparently handles both the single- and double-encoded
 * case without needing to know which one a given source uses. stripHtml()
 * decodes first, then replaces tags with a SPACE (never empty string) so
 * text on either side of an inline tag boundary — e.g.
 * "U.S. <strong>citizen</strong> only" — doesn't get glued into a single
 * unmatchable token once the tag is gone.
 */

function decodeHtmlEntities(text: string): string {
  let out = text
  for (let i = 0; i < 4; i++) {
    const next = out
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#0*39;|&apos;/gi, "'")
      .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
      .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    if (next === out) break
    out = next
  }
  return out
}

export function stripHtml(html: string | null | undefined): string | null {
  if (!html) return null
  const decoded = decodeHtmlEntities(html)
  // Replace with a space, not '', so an inline tag never fuses the words
  // on either side of it into one token.
  const withoutTags = decoded.replace(/<[^>]+>/g, ' ')
  const collapsed = withoutTags.replace(/\s+/g, ' ').trim()
  return collapsed.length > 0 ? collapsed : null
}
