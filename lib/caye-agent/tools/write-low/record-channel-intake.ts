import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { ChannelIntake } from '@/lib/channels/slots'
import type { Tool } from '../types'

interface RecordChannelIntakeInput {
  uses_instagram?: boolean
  uses_messenger?: boolean
  uses_whatsapp?: boolean
  whatsapp_line?: 'business' | 'personal' | 'landline'
  email_provider?: 'google' | 'zoho' | 'microsoft' | 'other'
  unsupported_tools?: string[]
}

/**
 * Records what the owner said about their setup. Merges into the existing
 * channel_intake blob rather than replacing it — answers arrive across
 * several messages and a later one must not wipe an earlier one.
 */
export const recordChannelIntake: Tool<RecordChannelIntakeInput> = {
  name: 'record_channel_intake',
  description:
    "Save what the owner tells you about their setup, so the connect flow knows what to " +
    "offer. Call this the moment they answer — don't batch it up.\n\n" +
    "whatsapp_line is the important one, and you must ask before ever offering WhatsApp:\n" +
    "- 'business' — a separate line just for the business. Safe to connect.\n" +
    "- 'landline' — also safe, and loses nothing.\n" +
    "- 'personal' — the phone they use themselves. Connecting would migrate the number and " +
    "kill WhatsApp on their handset, so it's off the table permanently. Record it and move on; " +
    "don't revisit it later.\n\n" +
    "Ask it plainly, e.g. \"is the number guests message you on a separate business line, or " +
    "the same phone you use yourself?\"\n\n" +
    "unsupported_tools: when they name something Caye has no connector for (Outlook, Square, " +
    "Calendly), record it and say honestly that you're not hooked into it yet. Don't pretend " +
    "you can connect it, and don't quietly drop it.",
  risk: 'low',
  roles: ['owner', 'founder'],
  modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      uses_instagram: { type: 'boolean', description: 'Do guests message them on Instagram?' },
      uses_messenger: { type: 'boolean', description: 'Do guests message their Facebook Page?' },
      uses_whatsapp: { type: 'boolean', description: 'Do guests message them on WhatsApp at all?' },
      whatsapp_line: {
        type: 'string',
        enum: ['business', 'personal', 'landline'],
        description: "How the guest-facing WhatsApp number is set up. 'personal' blocks connection permanently.",
      },
      email_provider: {
        type: 'string',
        enum: ['google', 'zoho', 'microsoft', 'other'],
        description: 'Only needed if detection failed and you had to ask which email host they use.',
      },
      unsupported_tools: {
        type: 'array',
        items: { type: 'string' },
        description: 'Tools they named that Caye has no connector for.',
      },
    },
  },

  async execute(args, ctx) {
    const supabase = createServiceClient()

    const { data: config } = await supabase
      .from('workspace_ai_config')
      .select('channel_intake')
      .eq('workspace_id', ctx.workspaceId)
      .maybeSingle()

    const existing = (config?.channel_intake as ChannelIntake | null) ?? {}

    const inventory = { ...(existing.inventory ?? {}) }
    if (args.uses_instagram !== undefined) inventory.instagram = args.uses_instagram
    if (args.uses_messenger !== undefined) inventory.messenger = args.uses_messenger
    if (args.uses_whatsapp !== undefined) inventory.whatsapp = args.uses_whatsapp

    const merged: ChannelIntake = {
      ...existing,
      inventory,
      whatsappLine: args.whatsapp_line ?? existing.whatsappLine ?? null,
      emailProvider: args.email_provider ?? existing.emailProvider ?? null,
      unsupportedTools: args.unsupported_tools?.length
        ? Array.from(new Set([...(existing.unsupportedTools ?? []), ...args.unsupported_tools]))
        : existing.unsupportedTools,
    }

    const { error } = await supabase
      .from('workspace_ai_config')
      .update({ channel_intake: merged })
      .eq('workspace_id', ctx.workspaceId)

    if (error) return { ok: false, error: error.message }

    return {
      ok: true,
      data: {
        recorded: merged,
        whatsapp_blocked: merged.whatsappLine === 'personal' || inventory.whatsapp === false,
      },
    }
  },
}
