import { buildBackOfficeSystemPrompt } from '../../modes/back-office'
import { fakeReadTool, fakeWriteTool, fixtureCtx, SEND_REPLY_SCHEMA } from './helpers'
import type { ReplayTurnInput } from '../types'

/**
 * CASE E — send refinement then confirmation.
 *
 * Caye has staged a send_reply draft ("Send that?"). The owner replies
 * "add safe travels to it" — a mechanical refinement of the SAME
 * underlying message, not a new topic. This fixture replays that
 * refinement turn.
 *
 * WHERE THE REAL LIMIT LIVES (documented, not silently worked around):
 * `gateHighRisk` (`lib/caye-agent/tools/high-risk-gate.ts`) requires a
 * confirming send_reply call to carry byte-identical arguments to what was
 * staged — its own comments admit this: "rewording even slightly stages a
 * SECOND action... That has stranded real sends." This fixture's job is
 * NOT to test that mechanism (see `high-risk-gate.test.ts` for that) and
 * this phase does not change it — gateHighRisk is exactly the kind of
 * hard, code-enforced invariant the convergence plan says to preserve.
 * What this fixture checks is the step BEFORE that: does the model
 * correctly call `send_reply` again with a revised body that keeps the
 * original content and adds "safe travels," rather than treating "add
 * safe travels to it" as an ambiguous new instruction it can't act on. If
 * a later phase wants owner corrections like this to require only one
 * confirmation instead of two, the fix belongs in gateHighRisk gaining a
 * semantic (not byte-identical) same-intent check — explicitly out of
 * scope here.
 */
export function buildSendRefinementFixture(): ReplayTurnInput {
  const searchThreads = fakeReadTool(
    'search_threads',
    'Find a customer thread by fuzzy name or message text.',
    { matches: [{ conversation_id: 'conv_laney', customer_name: 'Laney (NBC Crew)', channel: 'whatsapp' }] }
  )
  const sendReply = fakeWriteTool(
    'send_reply',
    'Send a reply to a customer on their thread. HIGH-RISK.',
    'high',
    ['owner', 'founder'],
    SEND_REPLY_SCHEMA
  )

  const systemPrompt = buildBackOfficeSystemPrompt({
    profile: { operatorName: 'Mrs. Max', businessName: 'Bimini Island Tours' },
    caller: { role: 'owner', name: 'Mrs. Max' },
  })

  const messages = [
    {
      role: 'user' as const,
      content:
        'no i just want them to know that max will be there to greet them at 11:00 a.m. and they can contact him',
    },
    {
      role: 'assistant' as const,
      content:
        'Drafted for Laney (NBC Crew): "Hi Laney — Max will be there to greet you at 11:00 a.m., ' +
        'and you can reach him directly at 242-473-0233." Send that?',
    },
    { role: 'user' as const, content: 'add safe travels to it' },
  ]

  return {
    meta: {
      caseId: 'send-refinement',
      label: 'Send refinement — mechanical edit before confirmation',
      description:
        'Owner asks for a small addition to an already-staged draft. Checks the model re-stages ' +
        'send_reply with the addition folded into the same underlying message, rather than ' +
        'stalling or treating it as a new unrelated request. Does not test — and this phase does ' +
        'not change — the byte-identical confirmation mechanism itself (gateHighRisk).',
    },
    mode: 'back-office',
    systemPrompt,
    messages,
    ctx: fixtureCtx({ callerRole: 'owner' }),
    tools: [searchThreads, sendReply],
  }
}
