import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { Tool } from '../types'

interface UpdateTeamMemberPermissionsInput {
  phone_or_name: string
  role: 'owner' | 'staff'
}

export const updateTeamMemberPermissions: Tool<UpdateTeamMemberPermissionsInput> = {
  name: 'update_team_member_permissions',
  description:
    "Change a teammate's role. Use when the owner says \"promote Max to owner\" or \"set Sara " +
    "back to staff\".\n\n" +
    "Match by phone OR name (case-insensitive). Multi-match errors out so the owner can " +
    "disambiguate. founder rows cannot be modified through this tool — founder is platform-set.",
  risk: 'low',
  roles: ['owner', 'founder'],
  inputSchema: {
    type: 'object',
    properties: {
      phone_or_name: { type: 'string', description: 'Phone or name of the teammate.' },
      role: { type: 'string', enum: ['owner', 'staff'], description: 'New role.' },
    },
    required: ['phone_or_name', 'role'],
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

    if (matches.length === 0) {
      return { ok: false, error: `No teammate matches "${args.phone_or_name}".` }
    }
    if (matches.length > 1) {
      return {
        ok: false,
        error: `Multiple matches for "${args.phone_or_name}" — be more specific.`,
        data: { matches: matches.map((m) => ({ name: m.name, phone: m.phone, role: m.role })) },
      }
    }
    const target = matches[0]
    if (target.role === 'founder') {
      return { ok: false, error: "Can't modify a founder row through this tool." }
    }

    const { error } = await supabase
      .from('operator_allowlist')
      .update({ role: args.role })
      .eq('id', target.id)
    if (error) return { ok: false, error: error.message }

    return {
      ok: true,
      data: {
        name: target.name,
        phone: target.phone,
        previous_role: target.role,
        new_role: args.role,
      },
    }
  },
}
