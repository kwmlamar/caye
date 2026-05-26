import { describe, it, expect } from 'vitest'
import { formatHistoryBlock, type HistoryEntry } from './conversation-history'

describe('formatHistoryBlock', () => {
  it('returns empty string when there is no history', () => {
    // No history means this is a brand-new conversation — no block injected,
    // Caye replies to the new message with no prior context preamble.
    expect(formatHistoryBlock([])).toBe('')
  })

  it('labels customer rows as "Customer:" and business rows as "You:"', () => {
    // The block is read by Caye as a continuation of its own replies, so
    // the perspective is first-person: "You:" for the business side.
    const rows: HistoryEntry[] = [
      { sender_type: 'customer', content: 'Can I book Saturday?' },
      { sender_type: 'business', content: 'Sure! What time?' },
    ]
    const block = formatHistoryBlock(rows)
    expect(block).toContain('Customer: Can I book Saturday?')
    expect(block).toContain('You: Sure! What time?')
  })

  it('opens with the "PRIOR CONVERSATION" header and closes with a separator', () => {
    // The header tells Caye what this preamble is. The trailing separator
    // visually divides history from the new inbound message that follows.
    const block = formatHistoryBlock([
      { sender_type: 'customer', content: 'Hi' },
    ])
    expect(block).toMatch(/^PRIOR CONVERSATION/)
    expect(block.endsWith('---\n\n')).toBe(true)
  })

  it('tells Caye not to repeat itself', () => {
    // This instruction is the whole point of injecting history — otherwise
    // Caye would re-greet and re-ask things the customer already answered.
    const block = formatHistoryBlock([
      { sender_type: 'customer', content: 'Hi' },
    ])
    expect(block.toLowerCase()).toContain('do not repeat yourself')
  })

  it('trims whitespace from each message body', () => {
    const block = formatHistoryBlock([
      { sender_type: 'customer', content: '  hello   ' },
    ])
    expect(block).toContain('Customer: hello\n')
  })

  it('renders a null content as an empty body without crashing', () => {
    // unified_messages.content can technically be null (e.g. media-only
    // messages). The block should still render rather than throwing.
    const block = formatHistoryBlock([
      { sender_type: 'customer', content: null },
    ])
    expect(block).toContain('Customer: \n')
  })
})
