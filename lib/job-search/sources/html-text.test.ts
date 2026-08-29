import { describe, expect, it } from 'vitest'
import { stripHtml } from './html-text'

/**
 * Regression fixtures for the CAY-192 audit (PR #196). The original
 * stripHtml only handled literal `<tag>` markup. Verified live against
 * boards-api.greenhouse.io (2026-08-28): real Greenhouse `content` is
 * double-HTML-entity-encoded (a raw wire response containing the JSON
 * escape `&lt;strong&gt;` decodes, after JSON.parse, to the
 * literal text `&lt;strong&gt;` — not an actual `<strong>` tag), which the
 * original regex silently failed to touch at all. These fixtures use real
 * shapes captured from that verification, not hypothetical examples.
 */
describe('stripHtml — real-world Greenhouse/Lever content shapes', () => {
  it('strips single-encoded literal HTML tags (Lever shape)', () => {
    const input = '<div>\n\n<li>1+ years work experience</li>\n<li>Must be a U.S. citizen</li>\n\n</div>'
    const result = stripHtml(input)
    expect(result).not.toMatch(/[<>]/)
    expect(result).toMatch(/1\+ years work experience/)
    expect(result).toMatch(/Must be a U\.S\. citizen/)
  })

  it('strips double-HTML-entity-encoded content (real Greenhouse shape)', () => {
    // Exact shape verified live: raw content field is the entity-encoded
    // TEXT "&lt;p&gt;...&lt;/p&gt;", not literal <p> tags.
    const input = '&lt;div class=&quot;content-intro&quot;&gt;&lt;p&gt;Must be a U.S. citizen to apply.&lt;/p&gt;&lt;/div&gt;'
    const result = stripHtml(input)
    expect(result).not.toMatch(/&lt;|&gt;|&quot;/)
    expect(result).toBe('Must be a U.S. citizen to apply.')
  })

  it('decodes &amp;nbsp; into a real space rather than gluing adjacent words together', () => {
    // Verified live: a real GitLab posting contained literally
    // "values&amp;nbsp;and" with ZERO real whitespace bytes between the
    // words — decoding &amp; first (-> &nbsp;) then &nbsp; (-> a real
    // space) is required, in that order, to recover "values and".
    const input = 'our values&amp;nbsp;and continuous knowledge exchange'
    const result = stripHtml(input)
    expect(result).toBe('our values and continuous knowledge exchange')
  })

  it('does not let an inline tag glue two words together into one unmatchable token', () => {
    // "U.S. <strong>citizen</strong>" — if tags were deleted rather than
    // replaced with a space, and there were zero whitespace bytes on one
    // side, "U.S." and "citizen" could end up directly adjacent. Replacing
    // tags with a space (not '') is what prevents that.
    const input = 'Applicants must be a U.S.<strong>citizen</strong>to be considered.'
    const result = stripHtml(input)
    expect(result).toMatch(/U\.S\.\s+citizen\s+to be considered/)
  })

  it('handles the double-encoded form of an inline tag splitting a phrase (real Greenhouse risk)', () => {
    const input = 'Must be a U.S. &lt;strong&gt;citizen&lt;/strong&gt; to apply.'
    const result = stripHtml(input)
    expect(result).toBe('Must be a U.S. citizen to apply.')
  })

  it('returns null for empty/whitespace-only/null input', () => {
    expect(stripHtml(null)).toBeNull()
    expect(stripHtml(undefined)).toBeNull()
    expect(stripHtml('')).toBeNull()
    expect(stripHtml('   ')).toBeNull()
    expect(stripHtml('&lt;div&gt;&lt;/div&gt;')).toBeNull()
  })

  it('collapses repeated whitespace from adjacent tags/newlines', () => {
    const input = '<div>\n\n<p>Hello</p>\n\n\n<p>World</p>\n</div>'
    expect(stripHtml(input)).toBe('Hello World')
  })
})
