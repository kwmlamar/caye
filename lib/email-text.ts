/**
 * Pure email-body cleaning. Converts HTML email bodies to readable plain
 * text and strips the noisy bits that downstream consumers (Caye prompts,
 * customer style learning, conversation history) shouldn't see:
 *
 *   - <style>/<script>/<head> block contents (Outlook inlines lots of CSS)
 *   - Quoted-reply chains (the whole prior thread gets dumped into every reply)
 *
 * Server-only-free so it can be unit tested without the Next.js sentinel
 * package. Replaces the duplicated htmlToPlainText functions previously
 * inlined in app/api/webhooks/zoho-email/route.ts and app/api/email/poll/route.ts.
 */

/**
 * Strip the *contents* of <style>, <script>, and <head> blocks so their
 * inner CSS/JS doesn't survive as visible text once the surrounding tags
 * are removed.
 */
function stripHtmlBlockContents(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<head[\s\S]*?<\/head>/gi, '')
}

/**
 * Detect the start of a quoted reply / forwarded chain and cut everything
 * from that point on. Patterns covered (case-insensitive):
 *   - "On <date>, <name> wrote:" (Gmail / Apple Mail / most clients)
 *   - "-----Original Message-----" / "--- Original Message ---" (Outlook)
 *   - Outlook forward header: a "From: ..." line directly followed by
 *     "Sent:" or "Date:" within the next few lines
 *   - A run of lines starting with ">" (plain-text quoting)
 *
 * Multiple patterns may match — we keep the earliest cut point to avoid
 * leaking any prior-thread content.
 */
function stripQuotedReply(text: string): string {
  const candidates: number[] = []

  // "On ..., <name> wrote:" — handles single- and multi-line variants
  const onWrote = text.search(
    /(^|\n)\s*on\b[\s\S]{0,300}?\bwrote:\s*(\n|$)/i
  )
  if (onWrote !== -1) candidates.push(onWrote)

  // Outlook "-----Original Message-----" (any number of dashes, optional spaces)
  const originalMessage = text.search(/(^|\n)\s*-{2,}\s*original message\s*-{2,}/i)
  if (originalMessage !== -1) candidates.push(originalMessage)

  // Outlook forward header — a "From:" line followed within ~3 lines by
  // a "Sent:" or "Date:" line. We require the proximity so a customer
  // signing off with "From, Alice" doesn't accidentally trigger.
  const forwardHeader = text.search(
    /(^|\n)\s*from:\s.+\n(?:.*\n){0,2}\s*(sent|date):\s/i
  )
  if (forwardHeader !== -1) candidates.push(forwardHeader)

  // First run of ">"-prefixed lines (plain-text quoting). We anchor on
  // a line start so ">" mid-sentence (rare) doesn't trip us.
  const angleQuote = text.search(/(^|\n)>\s?.+/)
  if (angleQuote !== -1) candidates.push(angleQuote)

  if (!candidates.length) return text
  const cut = Math.min(...candidates)
  return text.slice(0, cut)
}

/**
 * Convert an HTML email body to clean plain text suitable for storing in
 * unified_messages.content and feeding into Caye. Handles plain text input
 * (no HTML tags) as well — the caller doesn't need to check first.
 */
export function htmlToPlainText(input: string): string {
  // Strip CSS/JS/head blocks first so their contents don't leak through
  // when we remove the surrounding tags.
  let s = stripHtmlBlockContents(input)

  s = s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n\n')
    // Treat other block-level closings as line breaks so HTML tables /
    // lists (Web3Forms-style booking emails) don't collapse to one line
    .replace(/<\/(tr|td|th|li|div|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    // Normalize line endings + strip per-line padding so quote-cut regexes
    // anchored on \n work consistently across CRLF / leading-whitespace input
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(l => l.replace(/^[ \t]+/, '').replace(/[ \t]+$/, ''))
    .join('\n')

  // Strip the quoted reply chain AFTER tag removal so HTML markers like
  // <blockquote> become plain text first (the ">" patterns then catch them).
  s = stripQuotedReply(s)

  return s.replace(/\n{3,}/g, '\n\n').trim()
}
