import { buildFrontDeskSituationSystemPrompt } from '../../modes/front-desk-situation'
import { buildSyntheticSituation, fixtureCtx } from './helpers'
import type { ReplayTurnInput } from '../types'

/**
 * REAL HISTORY — Will, reconstructed from actual production data.
 *
 * PHASE 1B (2026-08-16): read from `unified_messages` for the real Bimini
 * workspace, read-only. This is the ACTUAL conversation the audit's "Will"
 * continuity case was drawn from — a 2-day airport-transfer booking
 * exchange (2026-08-13 to 2026-08-15), currently-deployed front-desk
 * prompt (`lib/caye-reply.ts`, unchanged by this convergence work). The
 * real production reply that followed the customer's payment
 * confirmation — timestamped 2 minutes after it — opened with "Hi Will,"
 * despite eight prior exchanges; a second, separate outbound message nine
 * minutes later did the same. Both are the exact bug this case exists to
 * evaluate, confirmed live in production data rather than reconstructed
 * from memory.
 *
 * PII SCRUBBED: real surname, email, phone, and exact accommodation name
 * are not reproduced — only the first name (already the audit's case
 * identifier), the booking shape, and the timing that matters for this
 * test. Message content is otherwise verbatim from the real thread.
 */
export function buildRealContinuityWillFixture(): ReplayTurnInput {
  const now = '2026-08-14T23:58:55.671Z' // moment of the customer's payment message below, +0s

  const situation = buildSyntheticSituation({
    channel: 'front-desk',
    workspaceId: 'ws_bimini_real',
    now,
    turns: [
      {
        role: 'assistant',
        content:
          "Hi Will, Thanks for reaching out. Let me check on transportation availability for your " +
          "August 15 arrival. To make sure we look at the right option, could you share your arrival " +
          "time, whether you'll be arriving by ferry or plane, and the name of your accommodation? " +
          "We'll follow up once we've confirmed what's available.",
        at: '2026-08-13T22:23:53.603Z',
      },
      {
        role: 'user',
        content: '10:54 am. Plane at the South Bimini Airport. Staying in Port Royale.',
        at: '2026-08-13T22:28:47.194Z',
      },
      {
        role: 'assistant',
        content: 'Hi Will, We are coordinating it from this end will provide you with all of the details first thing in the morning.',
        at: '2026-08-14T01:31:23.965Z',
      },
      {
        role: 'assistant',
        content:
          'Hi Will, Following up on our earlier conversation, we are pleased to confirm that we can ' +
          'accommodate your transportation from South Bimini Airport to your accommodation in Port ' +
          'Royale on Saturday, August 15. Private VIP Escort — Total rate: $125.00 (2 guests). This ' +
          'covers your full round-trip transportation. An invoice will be sent to you for payment.',
        at: '2026-08-14T18:02:48.890Z',
      },
      {
        role: 'user',
        content: 'I have not yet received the invoice for payment.',
        at: '2026-08-14T23:11:27.627Z',
      },
      {
        role: 'assistant',
        content:
          'Hi Will, Thank you for following up. We apologize for the delay. Mrs. Max will have your ' +
          'invoice sent over to you shortly.',
        at: '2026-08-14T23:12:07.569Z',
      },
    ],
  })

  const messages = [
    ...situation.historyForModel,
    { role: 'user' as const, content: 'just now — Just laid it and got my receipt!' },
  ]

  const systemPrompt = buildFrontDeskSituationSystemPrompt({
    businessName: 'Bimini Island Tours',
    channel: 'whatsapp',
    situation,
  })

  return {
    meta: {
      caseId: 'real-continuity-will',
      label: 'REAL — Will, verbatim conversation from production',
      description:
        'Real conversation (PII scrubbed, content otherwise verbatim). The real production reply ' +
        'that followed "Just laid it and got my receipt!" opened with "Hi Will," 2 minutes later ' +
        'despite six prior exchanges over two days — confirmed live in production data. Checks ' +
        'whether a situation-aware, timestamped multi-turn context (this phase\'s change) avoids ' +
        'that on the same real conversation, using the front-desk situation probe prompt rather ' +
        'than the currently-deployed lib/caye-reply.ts (which this phase does not touch).',
    },
    mode: 'front-desk',
    systemPrompt,
    messages,
    ctx: fixtureCtx({ callerRole: 'founder' }),
    tools: [],
    situation,
  }
}
