import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { Tool } from '../types'
import { HIGH_RISK_CONFIRMATION_PREAMBLE } from './_booking-helpers'

interface RemoveTeamMemberInput {
  phone_or_name: string
}

export const removeTeamMember: Tool<RemoveTeamMemberInput> = {
  name: 'remove_team_member',
  description:
    `Remove a teammate's access to Caye. After removal, their messages from WhatsApp are ` +
    `dropped. Match by phone OR name (case-insensitive). Multi-match errors out. ` +
    `founder rows cannot be removed through this tool. ${HIGH_RISK_CONFIRMATION_PREAMBLE}`,
  risk: 'high',
  roles: ['owner', 'founder'],
  modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      phone_or_name: { type: 'string', description: 'Phone or name of the teammate to remove.' },
    },
    required: ['phone_or_name'],
  },

  async execute(args, ctx) {
    const needle = args.phone_or_name.trim()
    const digits = needle.replace(/\D/g, '')

    const supabase = createServiceClient()
    const { data: rows } = await supabase
      .from('operator_allowlist')
      .select('id, phone, role, name')
      .eq('workspace_id', ctx.workspaceId)

    const all = (rows ?? []) as Array<{
      id: number
      phone: string
      role: string
      name: string | null
    }>
    const matches = all.filter((r) => {
      if (digits.length >= 8 && r.phone.replace(/\D/g, '').endsWith(digits)) return true
      if (r.name && r.name.toLowerCase() === needle.toLowerCase()) return true
      return false
    })
    if (matches.length === 0) return { ok: false, error: `No teammate matches "${needle}".` }
    if (matches.length > 1) {
      return {
        ok: false,
        error: `Multiple matches for "${needle}" — be more specific.`,
        data: { matches: matches.map((m) => ({ name: m.name, phone: m.phone, role: m.role })) },
      }
    }
    const target = matches[0]
    if (target.role === 'founder') {
      return { ok: false, error: "Can't remove a founder row through this tool." }
    }

    const { error } = await supabase.from('operator_allowlist').delete().eq('id', target.id)
    if (error) return { ok: false, error: error.message }

    return {
      ok: true,
      data: {
        removed: { name: target.name, phone: target.phone, role: target.role },
      },
    }
  },
}
