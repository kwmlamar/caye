import { buildBackOfficeSystemPrompt } from '../../modes/back-office'
import { fakeReadTool, fixtureCtx } from './helpers'
import type { ReplayTurnInput } from '../types'

/**
 * CASE F — correct no-action.
 *
 * Nothing is actually open: `get_held_queue` and `get_today_summary` both
 * come back clean, and the owner sends a plain check-in with no open loop
 * behind it. This mirrors how production actually surfaces "nothing is
 * open" on a live chat turn — the attention ledger
 * (`renderAttentionContext`) is only threaded into the system prompt on a
 * proactive `origin: 'scan'` turn (see `modes/back-office.ts`); on an
 * ordinary chat reply, as here, the read tools are the source of truth,
 * exactly as the existing "WHAT YOU CAN DO RIGHT NOW" block instructs.
 *
 * Correct behavior is recognizing there's nothing to do: no proposed
 * actions, and — per the existing "Don't pad a clean result" instruction
 * already in the prompt — at most a one-line "you're clear" answer, never
 * a fabricated status report.
 */
export function buildNoUnnecessaryActionFixture(): ReplayTurnInput {
  const getHeldQueue = fakeReadTool('get_held_queue', 'Items held that need the owner\'s call.', { items: [] })
  const getTodaySummary = fakeReadTool('get_today_summary', 'Quick read on today.', {
    confirmed_bookings: 3,
    revenue_today: '$450',
    holds: 0,
  })

  const systemPrompt = buildBackOfficeSystemPrompt({
    profile: { operatorName: 'Mrs. Max', businessName: 'Bimini Island Tours' },
    caller: { role: 'owner', name: 'Mrs. Max' },
    origin: 'chat',
  })

  return {
    meta: {
      caseId: 'no-unnecessary-action',
      label: 'Correct no-action — nothing is actually open',
      description:
        'Owner sends a plain check-in with no open loop behind it; the held queue and today ' +
        'summary both come back clean. Checks that Caye recognizes there is nothing to do rather ' +
        'than manufacturing work or padding a clean answer — reviewerJudgment.correctNoAction is ' +
        'the field a human marks against this fixture.',
    },
    mode: 'back-office',
    systemPrompt,
    messages: [{ role: 'user', content: 'anything going on?' }],
    ctx: fixtureCtx({ callerRole: 'owner' }),
    tools: [getHeldQueue, getTodaySummary],
  }
}
