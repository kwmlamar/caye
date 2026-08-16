import { buildBackOfficeSystemPrompt } from '../../modes/back-office'
import { fakeReadTool, fakeWriteTool, fixtureCtx, SEND_REPLY_SCHEMA } from './helpers'
import type { ReplayTurnInput } from '../types'

/**
 * CASE D — correction / narrowing.
 *
 * Caye has already proposed an over-broad reply (mirroring the historical
 * NBC/Laney over-expansion). The owner corrects: "no i just want them to
 * know that max will be there to greet them at 11:00 a.m. and they can
 * contact him." Checks that the correction is understood as narrowing the
 * SAME staged action, not as an unrelated new task — the model should
 * recompose the send_reply draft to the owner's actual scope, not treat
 * the correction as something to also fold in alongside the original
 * over-broad draft.
 *
 * `search_threads` is included alongside `send_reply`: the prior draft in
 * history is reconstructed prose, not a real persisted tool_use/tool_result
 * pair, so the model has no cached conversation_id to reuse — exactly like
 * a real agent turn that doesn't already have one in its own tool-call
 * history. Omitting a way to resolve it (an earlier draft of this fixture
 * did) doesn't test scope-narrowing, it tests whether the model can invent
 * a required string it was never given — a different, uninteresting
 * failure mode this phase isn't trying to measure.
 */
export function buildCorrectionNarrowingFixture(): ReplayTurnInput {
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
        'I want the NBC Crew to know that Max will waiting on their arrival and that they ' +
        'could feel free to contact him directly at 242-473-0233',
    },
    {
      role: 'assistant' as const,
      content:
        'Drafted for Laney (NBC Crew): "Hi Laney — a couple of updates: yes, please bring your ' +
        'own gear for the shoot, and there\'s parking near the dock for your van. Also, Max ' +
        'will be waiting on your arrival and you can reach him directly at 242-473-0233." Send that?',
    },
    {
      role: 'user' as const,
      content:
        'no i just want them to know that max will be there to greet them at 11:00 a.m. and they can contact him',
    },
  ]

  return {
    meta: {
      caseId: 'correction-narrowing',
      label: 'Correction — narrowing an over-broad draft',
      description:
        'Owner corrects a draft that expanded beyond her original ask. Checks the correction is ' +
        'treated as amending the same staged send_reply to the narrower scope, not as a separate ' +
        'new task layered on top of the original over-broad draft.',
    },
    mode: 'back-office',
    systemPrompt,
    messages,
    ctx: fixtureCtx({ callerRole: 'owner' }),
    tools: [searchThreads, sendReply],
  }
}
