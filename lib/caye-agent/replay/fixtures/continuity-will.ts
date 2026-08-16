import { buildFrontDeskSituationSystemPrompt } from '../../modes/front-desk-situation'
import { buildSyntheticSituation, fixtureCtx } from './helpers'
import type { ReplayTurnInput } from '../types'

/**
 * CASE A — ongoing customer continuity ("Will").
 *
 * Reconstructs the shape of the real failure: a customer has been
 * exchanging messages about an invoice/payment/arrival recently, then
 * writes "Just paid and got my receipt!" a few minutes later. The old
 * front-desk path (`lib/caye-reply.ts`) decides whether to greet from a
 * single upstream-computed `isFirstMessage` boolean and never shows the
 * model any elapsed time at all (see the architectural audit, Case 2).
 *
 * This fixture builds the SAME conversation through the new situation
 * assembler instead — real multi-turn history, each of Will's messages
 * carrying a relative-time marker the model can actually reason from — and
 * gives the model no canned greeting/no-greeting branch to follow. What
 * "correct" looks like here is the model continuing the conversation the
 * way any human who'd been in it the whole time would, using the timing
 * evidence in front of it — not a rule this fixture enforces.
 *
 * NOTE ON VERIFICATION: this file only builds the `ReplayTurnInput`. Its
 * companion test (`fixtures.test.ts`) checks that the situation and prompt
 * are constructed correctly (real multi-turn shape, correct relative-time
 * markers, no greeting instruction baked in). Actually running this
 * against a live model to observe the reply is a manual step, not part of
 * the automated suite — this phase deliberately did not spend API calls
 * verifying live-model behavior; see the Phase 1 report for why.
 */
export function buildContinuityWillFixture(): ReplayTurnInput {
  const now = '2026-08-14T15:40:00.000Z'

  const situation = buildSyntheticSituation({
    channel: 'front-desk',
    workspaceId: 'ws_bimini',
    now,
    turns: [
      { role: 'user', content: 'Hi, I wanted to check on my booking for Saturday — has the invoice gone out yet?', at: '2026-08-14T15:10:00.000Z' },
      { role: 'assistant', content: "Your spot is held for Saturday. We'll send payment details over shortly to lock it in.", at: '2026-08-14T15:12:00.000Z' },
      { role: 'user', content: 'Got it, thanks — what time does the tour actually start?', at: '2026-08-14T15:20:00.000Z' },
      { role: 'assistant', content: 'It starts at 10am, meeting at the marina dock.', at: '2026-08-14T15:22:00.000Z' },
      { role: 'assistant', content: "Here's the payment link for Saturday's tour — $150 total.", at: '2026-08-14T15:37:00.000Z' },
    ],
  })

  const newInboundAt = '2026-08-14T15:40:00.000Z'
  const messages = [
    ...situation.historyForModel,
    { role: 'user' as const, content: `just now — Just paid and got my receipt!` },
  ]

  const systemPrompt = buildFrontDeskSituationSystemPrompt({
    businessName: 'Bimini Island Tours',
    channel: 'whatsapp',
    situation,
  })

  return {
    meta: {
      caseId: 'continuity-will',
      label: 'Will — ongoing conversation continuity',
      description:
        'Customer writes "Just paid and got my receipt!" 3 minutes after Caye\'s own last ' +
        'message in an active conversation. Checks that a situation-aware, timestamped, ' +
        'multi-turn context lets the model continue naturally instead of restarting the ' +
        'relationship with a first-contact greeting. new inbound timestamp: ' +
        newInboundAt,
    },
    mode: 'front-desk',
    systemPrompt,
    messages,
    ctx: fixtureCtx({ callerRole: 'founder' }),
    tools: [],
    situation,
  }
}
