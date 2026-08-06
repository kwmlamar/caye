import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { getChannelState, SLOT_LABEL } from '@/lib/channels/slots'
import type { Tool } from '../types'

/**
 * The agent's window onto the connect walkthrough. State is *derived*
 * from connected_accounts + workspace_ai_config.channel_intake on every
 * call rather than stored, so it stays correct when someone ignores Caye
 * for a week and then connects something from the dashboard.
 */
export const getChannelStatus: Tool<Record<string, never>> = {
  name: 'get_channel_status',
  description:
    "Check which channels this workspace has connected, which are still missing, and which " +
    "one to offer next. Use before offering a connect link, when the operator asks what's " +
    "connected or \"am I live?\", when they say a channel isn't working, and any time you're " +
    "about to talk about setup.\n\n" +
    "Returns `connected` (live now), `missing` (worth offering, in the order to offer them), " +
    "`gated` (deliberately withheld — read the reason and do NOT offer these), `next` (the one " +
    "to offer), and `is_live` (false means Caye is receiving nothing at all — that's urgent, " +
    "not a nice-to-have).\n\n" +
    "A gated reason of 'personal_phone' means the owner runs the business from their own " +
    "phone: connecting it would migrate the number and kill WhatsApp on their handset. Never " +
    "push WhatsApp at them — reassure them they still reach you on this number, and that " +
    "email and Instagram cover their guests.",
  risk: 'read',
  roles: ['owner', 'staff', 'founder'],
  modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {},
  },

  async execute(_args, ctx) {
    const supabase = createServiceClient()
    const state = await getChannelState(supabase, ctx.workspaceId)

    const { data: config } = await supabase
      .from('workspace_ai_config')
      .select('channel_intake')
      .eq('workspace_id', ctx.workspaceId)
      .maybeSingle()

    return {
      ok: true,
      data: {
        connected: state.connected.map((s) => SLOT_LABEL[s]),
        missing: state.missing.map((s) => SLOT_LABEL[s]),
        gated: state.gated.map((g) => ({ channel: SLOT_LABEL[g.slot], reason: g.reason })),
        next: state.next ? SLOT_LABEL[state.next] : null,
        is_live: state.isLive,
        // NULL intake means this workspace predates the walkthrough. Caye
        // must not start one unprompted — they're an existing customer who
        // already settled their setup. Answer questions, don't initiate.
        walkthrough_eligible: config?.channel_intake != null,
      },
    }
  },
}
