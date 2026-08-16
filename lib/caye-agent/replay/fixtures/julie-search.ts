import { buildBackOfficeSystemPrompt } from '../../modes/back-office'
import { annotateHistoryWithRelativeTime } from '../../situation'
import { fakeReadTool, fixtureCtx } from './helpers'
import type { ReplayTurnInput } from '../types'

/**
 * CASE C — the good interaction: Julie search.
 *
 * Mrs. Max: "who wants a 10:00 a.m. Sit Low Tour" → Caye answers. Mrs. Max:
 * "Julie" → Caye finds two Julies and asks which. Mrs. Max: "is there a
 * Julie King" → Caye searches and correctly reports none.
 *
 * This is the audit's positive control, not a regression to fix — it's
 * included so the replay harness has a documented example of the target
 * behavior (investigate incrementally, never guess identity, ask only
 * when genuinely ambiguous) to compare failing cases against. The fixture
 * replays the LAST turn ("is there a Julie King") with the two-Julie
 * clarification already in history, so what's being checked is whether
 * Caye calls `get_customer` again rather than assuming the answer from
 * the earlier ambiguous match still in her sliding-window memory —
 * exactly the "trust tools over memory" instruction already in
 * `modes/back-office.ts`.
 */
export function buildJulieSearchFixture(): ReplayTurnInput {
  const now = '2026-08-16T10:05:00.000Z'

  const getCustomer = fakeReadTool('get_customer', 'Look up a customer by name, phone, or email.', {
    matches: [] as unknown[],
    note: 'No customer named "Julie King" found for this workspace.',
  })

  const history = [
    { role: 'user' as const, content: 'who wants a 10:00 a.m. Sit Low Tour' },
    {
      role: 'assistant' as const,
      content: 'Saturday 10am Sit Low: Marcus Reid (2 guests, confirmed) and Julie Anders (1 guest, pending).',
    },
    { role: 'user' as const, content: 'Julie' },
    {
      role: 'assistant' as const,
      content:
        'Two Julies on file — Julie Anders (Saturday 10am Sit Low, pending) and Julie Marsh ' +
        '(no upcoming bookings). Which one?',
    },
  ]
  const timestamps = ['2026-08-16T10:00:00.000Z', '2026-08-16T10:00:30.000Z', '2026-08-16T10:02:00.000Z', '2026-08-16T10:02:20.000Z']
  const annotatedHistory = annotateHistoryWithRelativeTime(history, timestamps, now)

  const systemPrompt = buildBackOfficeSystemPrompt({
    profile: { operatorName: 'Mrs. Max', businessName: 'Bimini Island Tours' },
    caller: { role: 'owner', name: 'Mrs. Max' },
  })

  return {
    meta: {
      caseId: 'julie-search',
      label: 'Julie search — the good interaction (positive control)',
      description:
        'Owner narrows an ambiguous customer reference across three turns; the final turn ' +
        '("is there a Julie King") should trigger a fresh get_customer lookup rather than a ' +
        'guess from sliding-window memory, and correctly report no match — the target pattern ' +
        'this replay suite compares failing cases against.',
    },
    mode: 'back-office',
    systemPrompt,
    messages: [...annotatedHistory, { role: 'user', content: 'is there a Julie King' }],
    ctx: fixtureCtx({ callerRole: 'owner' }),
    tools: [getCustomer],
  }
}
