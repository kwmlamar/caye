/**
 * Pure formatting for the conversation-history block Caye sees before
 * replying. Extracted from caye-reply.ts so it can be unit tested
 * without server-only deps.
 */

export interface HistoryEntry {
  sender_type: 'customer' | 'business'
  content: string | null
}

/**
 * Render a list of prior messages as a "PRIOR CONVERSATION" preamble
 * for Caye's prompt. Returns an empty string when there is no history,
 * so callers can safely concatenate without adding noise.
 *
 * Customer messages render as "Customer:" and outbound business
 * messages render as "You:" — Caye reads the block as a continuation
 * of its own past replies.
 */
export function formatHistoryBlock(rows: HistoryEntry[]): string {
  if (!rows.length) return ''
  const lines = rows.map(r => {
    const speaker = r.sender_type === 'customer' ? 'Customer' : 'You'
    const text = (r.content ?? '').trim()
    return `${speaker}: ${text}`
  })
  return (
    'PRIOR CONVERSATION (oldest first — for context only, do not repeat yourself):\n' +
    lines.join('\n\n') +
    '\n\n---\n\n'
  )
}
