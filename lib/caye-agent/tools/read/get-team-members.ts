import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { Tool } from '../types'

interface AllowlistRow {
  id: number
  name: string | null
  phone: string
  role: string
  verified_at: string | null
}

export const getTeamMembers: Tool<Record<string, never>> = {
  name: 'get_team_members',
  description:
    "List everyone on the workspace's WhatsApp allowlist — owner, staff, drivers, and the " +
    "founder row. Use when the operator asks \"how many members in this workspace\", \"who's " +
    "on the team\", or before calling remove_team_member / update_team_member_permissions so " +
    "you know exact names/phones. Includes pending (unverified) invites, tagged as such. Each " +
    "member's `id` is their operator_allowlist_id — the canonical identifier send_operator_message " +
    "requires to message them directly.",
  risk: 'read',
  roles: ['owner', 'staff', 'founder'],
  modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {},
  },

  async execute(_args, ctx) {
    const supabase = createServiceClient()

    const { data: rows, error } = await supabase
      .from('operator_allowlist')
      .select('id, name, phone, role, verified_at')
      .eq('workspace_id', ctx.workspaceId)
      .order('role')
    if (error) return { ok: false, error: error.message }

    const members = (rows ?? []) as AllowlistRow[]
    const items = members.map((m) => ({
      id: m.id,
      name: m.name,
      phone: m.phone,
      role: m.role,
      verified: m.verified_at !== null,
    }))

    return {
      ok: true,
      data: {
        members: items,
        count: items.length,
        verified_count: items.filter((m) => m.verified).length,
      },
    }
  },
}
