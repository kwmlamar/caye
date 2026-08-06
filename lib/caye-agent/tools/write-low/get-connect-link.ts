import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { buildConnectUrl } from '@/lib/channels/connect-token'
import type { ConnectChannel } from '@/lib/channels/channel-types'
import { getChannelState, whatsAppAvailability, type ChannelIntake } from '@/lib/channels/slots'
import type { Tool } from '../types'

interface GetConnectLinkInput {
  channel: 'email' | 'whatsapp' | 'instagram' | 'messenger'
}

/**
 * Mints a fresh signed connect link for Caye to paste into her reply.
 *
 * Returns the URL rather than sending it as a separate message — the
 * agent's reply is already a WhatsApp send, and a tool-side send would
 * arrive as a second, racing message (the ordering bug already documented
 * in lib/onboarding-whatsapp.ts around the demo offer).
 *
 * Links expire (see lib/channels/connect-token). That's deliberate and
 * costs nothing precisely *because* this tool exists: "send it again"
 * mints a new one, which is a better support path than a link that lives
 * forever in someone's chat history.
 */
export const getConnectLink: Tool<GetConnectLinkInput> = {
  name: 'get_connect_link',
  description:
    "Generate a connect link for one channel, then include the URL in your reply. Call " +
    "get_channel_status first so you offer the right one.\n\n" +
    "Offer ONE channel at a time — a message with three links gets none of them tapped. " +
    "After they connect, you'll be told automatically; don't ask them to confirm.\n\n" +
    "'email' resolves to Gmail or Zoho automatically from their email domain. If we can't " +
    "tell, the tool says so — ask them which one they use and call again.\n\n" +
    "WhatsApp is special and this tool enforces it: connecting a number migrates it to the " +
    "business API and the WhatsApp app STOPS WORKING on that phone. If the owner hasn't " +
    "confirmed the number is a separate business line (or a landline), this tool refuses and " +
    "returns blocked — do not argue with that, and never hand them a WhatsApp link another " +
    "way. Ask whether guests message a business line or their own phone, record it, then " +
    "retry.\n\n" +
    "Links expire after about a week. If they say it didn't work or came back later, just " +
    "call this again for a fresh one.",
  risk: 'low',
  roles: ['owner', 'founder'],
  modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      channel: {
        type: 'string',
        enum: ['email', 'whatsapp', 'instagram', 'messenger'],
        description: "Which channel to connect. 'email' picks Gmail vs Zoho for you.",
      },
    },
    required: ['channel'],
  },

  async execute(args, ctx) {
    const supabase = createServiceClient()

    const { data: config } = await supabase
      .from('workspace_ai_config')
      .select('channel_intake')
      .eq('workspace_id', ctx.workspaceId)
      .maybeSingle()
    const intake = (config?.channel_intake as ChannelIntake | null) ?? null

    const state = await getChannelState(supabase, ctx.workspaceId)

    let channel: ConnectChannel
    if (args.channel === 'email') {
      if (state.connected.includes('inbox')) {
        return { ok: true, data: { blocked: 'already_connected', channel: 'email' } }
      }
      // Detected from the owner's email domain during intake, not asked.
      const provider = intake?.emailProvider
      if (provider === 'google') channel = 'gmail'
      else if (provider === 'zoho') channel = 'zoho'
      else {
        return {
          ok: true,
          data: {
            blocked: 'provider_unknown',
            channel: 'email',
            explanation:
              "Can't tell whether they're on Gmail/Google Workspace or Zoho. Ask which one, " +
              'then call again.',
          },
        }
      }
    } else {
      channel = args.channel

      // Hard gate, in code rather than prompt text: connecting migrates
      // the number and kills the WhatsApp app on their handset. This is
      // destructive and irreversible, so it cannot rely on the model
      // remembering an instruction.
      if (channel === 'whatsapp') {
        const availability = whatsAppAvailability(intake)
        if (!availability.available) {
          return {
            ok: true,
            data: {
              blocked: availability.reason,
              channel: 'whatsapp',
              explanation:
                availability.reason === 'personal_phone'
                  ? "They run the business from their own phone. Connecting would kill WhatsApp " +
                    'on that handset. Leave it alone — tell them email and Instagram cover ' +
                    'their guests, and they still reach Caye on this number.'
                  : availability.reason === 'not_used'
                    ? 'They said guests do not message them on WhatsApp.'
                    : "Not established yet whether that number is a separate business line or " +
                      'their own phone. Ask, record the answer, then retry.',
            },
          }
        }
      }

      const slot = channel === 'whatsapp' ? 'whatsapp' : channel
      if (state.connected.includes(slot)) {
        return { ok: true, data: { blocked: 'already_connected', channel } }
      }
    }

    return {
      ok: true,
      data: {
        channel,
        url: buildConnectUrl(ctx.workspaceId, channel, { source: 'wa' }),
        expires_in_days: 7,
      },
    }
  },
}
