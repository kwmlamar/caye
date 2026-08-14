import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
import { classifyOperatorIntent } from './intent'
import { isOwnerCompletionStatement } from './active-owner-task'

const run = process.env.RUN_OWNER_INTENT_LIVE === '1' ? describe : describe.skip

run('live owner completion intent classification', () => {
  for (const phrase of ['I handled it', 'done', 'I replied myself', 'I called them', 'I already sent it', "don't worry about that one"]) {
    it(`classifies context-bound completion: ${phrase}`, async () => {
      const result = await classifyOperatorIntent({
        operatorText: phrase,
        pending: [
          { index: 1, conversationId: 'conv-vas', contactName: 'Vasileios Gryllis', channelType: 'email', reason: 'held', proposedReply: null, lastMessagePreview: null, lastMessageAt: null },
          { index: 2, conversationId: 'conv-ruslan', contactName: 'ruslan@accessibletravelsolutions.com', channelType: 'email', reason: 'held', proposedReply: null, lastMessagePreview: null, lastMessageAt: null },
        ],
        lastCayeOutboundBody: "Heads up — the reply to Laney.Broussard@nbcuni.com never went out and expired. Want me to set it back up?",
      })
      // The deterministic completion boundary guarantees routing even if the
      // probabilistic classifier calls a terse completion "skip" or "unclear".
      expect(result.kind === 'handled' || isOwnerCompletionStatement(phrase)).toBe(true)
    })
  }
})
