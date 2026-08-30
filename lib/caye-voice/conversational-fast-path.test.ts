import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase-server', () => ({ createServiceClient: vi.fn() }))
vi.mock('@/lib/caye-operator-messages', () => ({ persistAgentTurns: vi.fn() }))
vi.mock('@/lib/operator-identity', () => ({ resolveFounderOperator: vi.fn() }))
vi.mock('@/lib/caye-direct-threads', () => ({
  getThread: vi.fn(), setThreadStatus: vi.fn(), touchThread: vi.fn(), linkInsertedMessagesToThreads: vi.fn(),
}))
vi.mock('@/lib/caye-direct-threads-summarize', () => ({ maybeGenerateThreadTitle: vi.fn(), maybeRefreshThreadSummary: vi.fn() }))

import { conversationalVoiceReply } from './conversational-fast-path'

describe('conversationalVoiceReply', () => {
  it.each([
    ['Hey Caye, what’s up?', "I'm here. What's up?"],
    ['Hey Key, what’s up?', "I'm here. What's up?"],
    ["Hey, what's up, Key?", "I'm here. What's up?"],
    ['Yo Kay', "Hey. I'm here. What's up?"],
    ['Can you hear me?', 'Yep, I can hear you.'],
    ['thank you', 'Anytime.'],
  ])('fast-paths pure conversation: %s', (input, expected) => {
    expect(conversationalVoiceReply(input)).toBe(expected)
  })

  it.each([
    'What bookings do we have tomorrow?',
    'Hey Caye, what bookings do we have tomorrow?',
    'Send Mrs. Max a message.',
    'What happened with Autumn?',
    'Run the job search.',
    'Are there any held items?',
  ])('refuses operational or stateful turns: %s', (input) => {
    expect(conversationalVoiceReply(input)).toBeNull()
  })
})
