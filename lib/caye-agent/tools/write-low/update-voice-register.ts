import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { Tool } from '../types'

export const VOICE_REGISTERS = [
  'warm-local',
  'friendly-professional',
  'formal-professional',
  'casual',
] as const
export type VoiceRegister = (typeof VOICE_REGISTERS)[number]

export const VOICE_SCOPES = ['default', 'b2b', 'vip'] as const
export type VoiceScope = (typeof VOICE_SCOPES)[number]

interface UpdateVoiceRegisterInput {
  register: VoiceRegister
  scope?: VoiceScope
}

export const updateVoiceRegister: Tool<UpdateVoiceRegisterInput> = {
  name: 'update_voice_register',
  description:
    "Set the overall tone register Caye uses. Use when the owner says \"talk warmer\", \"be " +
    "more professional with agencies\", or \"keep it casual\".\n\n" +
    "Registers (pick the closest fit):\n" +
    "- warm-local: friendly, regional warmth (Bahamian dialect where natural). Default for SMB.\n" +
    "- friendly-professional: warm but neutral — no dialect, full names, complete sentences.\n" +
    "- formal-professional: business-formal — for partnerships, agencies, regulatory.\n" +
    "- casual: short and informal — for repeat regulars, returning friends-of-the-business.\n\n" +
    "Scope (defaults to 'default' = all guests):\n" +
    "- default: applies to all inbound unless a more-specific scope matches.\n" +
    "- b2b: only when the inbound classifier flags B2B / partnership / agency. Locks the 2026-06-06 " +
    "B2B-tone decision into a per-workspace setting.\n" +
    "- vip: reserved for the VIP segment (not yet auto-detected in v1 — sets the value for future use).",
  risk: 'low',
  roles: ['owner', 'founder'],
  inputSchema: {
    type: 'object',
    properties: {
      register: { type: 'string', enum: [...VOICE_REGISTERS], description: 'New register.' },
      scope: {
        type: 'string',
        enum: [...VOICE_SCOPES],
        description: 'Scope this register applies to. Defaults to \'default\'.',
      },
    },
    required: ['register'],
  },

  async execute(args, ctx) {
    const scope: VoiceScope = args.scope ?? 'default'
    if (!VOICE_REGISTERS.includes(args.register)) {
      return { ok: false, error: `Invalid register. Use one of: ${VOICE_REGISTERS.join(', ')}` }
    }
    if (!VOICE_SCOPES.includes(scope)) {
      return { ok: false, error: `Invalid scope. Use one of: ${VOICE_SCOPES.join(', ')}` }
    }

    const supabase = createServiceClient()
    const { data: customer } = await supabase
      .from('customers')
      .select('voice_register_overrides')
      .eq('id', ctx.workspaceId)
      .maybeSingle()

    const current = (customer?.voice_register_overrides as Record<string, string> | null) ?? {}
    const next = { ...current, [scope]: args.register }

    const { error } = await supabase
      .from('customers')
      .update({ voice_register_overrides: next })
      .eq('id', ctx.workspaceId)
    if (error) return { ok: false, error: error.message }

    return {
      ok: true,
      data: {
        scope,
        register: args.register,
        all_overrides: next,
      },
    }
  },
}
