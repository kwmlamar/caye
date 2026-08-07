import 'server-only'
import { getRecentInbound } from '../../workspace-feed'
import type { Tool } from '../types'

interface GetRecentInboundInput {
  limit?: number
}

export const getRecentInboundTool: Tool<GetRecentInboundInput> = {
  name: 'get_recent_inbound',
  description:
    "Who has written in most recently, newest first, one entry per thread, across every " +
    "connected channel. There is NO time window — this reaches back as far as it needs to.\n\n" +
    "Use this for 'who was the last person to email me?', 'has anyone written in?', " +
    "'who's waiting on me?', and any question about recent inbound where the operator has " +
    "not named a specific person. Do NOT use get_recent_activity for those — it is windowed, " +
    "so it returns nothing when the last message fell outside the window, which reads as " +
    "'nobody has written' and is wrong.\n\n" +
    "Every response carries `coverage`. If `threads` is empty you MUST read it before " +
    "answering: `live` lists the channels actually receiving, `gated` lists channels " +
    "deliberately not connected and why, and `last_received` gives the last time anything " +
    "arrived per channel. An empty result on a live channel means genuinely nobody has " +
    "written. `is_live: false` means Caye is receiving nothing at all — say so plainly, " +
    "that's urgent. Never answer 'nothing came in' without saying what you can see.",
  risk: 'read',
  roles: ['owner', 'staff', 'founder'],
  modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      limit: {
        type: 'number',
        description: 'How many threads to return. Defaults to 10, max 25.',
      },
    },
  },

  async execute(args, ctx) {
    const limit = Math.min(Math.max(args.limit ?? 10, 1), 25)
    const { threads, bounces, coverage } = await getRecentInbound(ctx.workspaceId, { limit })

    return {
      ok: true,
      data: {
        threads: threads.map((t) => ({
          conversation_id: t.conversationId,
          customer: t.customer,
          channel: t.channel,
          at: t.at,
          preview: t.preview,
        })),
        count: threads.length,
        // Delivery failures seen while scanning, excluded from `threads`
        // because a bounce is not a person writing in. A non-zero count
        // means addresses are unreachable and should stop being retried.
        bounces_skipped: bounces,
        coverage: {
          live: coverage.live,
          gated: coverage.gated,
          missing: coverage.missing,
          is_live: coverage.isLive,
          last_received: coverage.lastReceived,
        },
      },
    }
  },
}
