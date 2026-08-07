import 'server-only'
import { getWorkspaceFeed } from '../../workspace-feed'
import type { Tool } from '../types'

interface GetRecentActivityInput {
  hours?: number
}

export const getRecentActivity: Tool<GetRecentActivityInput> = {
  name: 'get_recent_activity',
  description:
    "Chronological feed of what actually happened in a window — guests writing in, bookings, " +
    "holds, escalations, bounces, channels going down. Defaults to the last 24 hours. Use for " +
    "\"what happened?\" and \"what's new since I last checked?\".\n\n" +
    "This is WINDOWED. For 'who was the last person to email me?' or 'has anyone written in?', " +
    "use get_recent_inbound instead — it has no window and will not report silence just " +
    "because the last message fell outside one.\n\n" +
    "The feed only carries things worth surfacing: what the outside world did, plus anything " +
    "that was supposed to happen and didn't (`is_failure: true`). Caye's own sends and the " +
    "operator's own actions are recorded but deliberately not listed here — say so if asked, " +
    "don't treat their absence as evidence they didn't happen.\n\n" +
    "`quiet: true` means nothing reportable happened in the window. Before saying so, read " +
    "`coverage`: `live` is what's actually receiving, `gated` is what's deliberately not " +
    "connected and why, `last_received` is the last arrival per channel. `is_live: false` " +
    "means Caye is receiving nothing at all — urgent, say it plainly. NEVER report absence " +
    "as fact without stating what you can see; on 2026-08-07 Caye told the founder nothing " +
    "had come in for a week and guessed the email channel was disconnected, while the channel " +
    "was live and 34 messages had arrived.",
  risk: 'read',
  roles: ['owner', 'staff', 'founder'],
  modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      hours: {
        type: 'number',
        description: 'Window in hours. Defaults to 24. Max 720 (30 days).',
      },
    },
  },

  async execute(args, ctx) {
    const feed = await getWorkspaceFeed(ctx.workspaceId, { hours: args.hours })

    return {
      ok: true,
      data: {
        window_hours: feed.windowHours,
        quiet: feed.quiet,
        events: feed.events.map((e) => ({
          at: e.at,
          type: e.type,
          customer: e.customer,
          channel: e.channel,
          conversation_id: e.conversationId,
          is_failure: e.isFailure,
          detail: e.detail,
        })),
        coverage: {
          live: feed.coverage.live,
          gated: feed.coverage.gated,
          missing: feed.coverage.missing,
          is_live: feed.coverage.isLive,
          last_received: feed.coverage.lastReceived,
        },
      },
    }
  },
}
