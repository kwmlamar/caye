import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { Tool } from '../types'

interface SwitchWorkspaceInput {
  workspace: string
}

interface CustomerRow {
  id: string
  business_name: string | null
}

/**
 * Founder-only tool — switch the active workspace for this founder's phone.
 * Stored in platform_settings under key `founder_active_workspace_<phone>`.
 * The whatsapp-operator webhook reads this on every inbound and re-routes
 * the founder to the targeted workspace instead of the most-recent allowlist
 * row. Sticky until the founder switches again.
 *
 * Security: founder must already have an operator_allowlist row on the
 * target workspace (which they will, since the founder trigger auto-inserts
 * one on every customer row). The tool re-verifies before flipping so an
 * accidentally-removed founder row doesn't grant access via state alone.
 */
export const switchWorkspace: Tool<SwitchWorkspaceInput> = {
  name: 'switch_workspace',
  description:
    "Switch which workspace you're operating in. Founder-only — operators (owners and staff) " +
    "are tied to a single workspace and don't use this tool.\n\n" +
    "Use when the founder says \"switch to <business>\", \"go to <business>\", \"change to <X>\", " +
    "\"talk to me about <X>\". Match the workspace by business name (case-insensitive, substring " +
    "match — \"bimini\" matches \"Bimini Island Tours\"). If the match is ambiguous (multiple " +
    "businesses match), ask the founder to be more specific before calling this tool.\n\n" +
    "After the switch, ALL subsequent founder DMs route to the new workspace until the founder " +
    "switches again. Confirm the switch in your reply: \"Done — you're on <business> now.\"",
  risk: 'low',
  roles: ['founder'],
  modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      workspace: {
        type: 'string',
        description: 'Business name to switch to. Substring match against customers.business_name.',
      },
    },
    required: ['workspace'],
  },

  async execute(args, ctx) {
    const needle = args.workspace.trim()
    if (needle.length < 2) {
      return { ok: false, error: 'Workspace name is too short — give me more to match on.' }
    }

    const supabase = createServiceClient()

    // Look up the founder's current phone from the allowlist row they came in
    // on. ctx.workspaceId is the CURRENT workspace; we need their phone to
    // re-route across workspaces. Pull from the active operator_allowlist row.
    const { data: callerRow } = await supabase
      .from('operator_allowlist')
      .select('phone')
      .eq('workspace_id', ctx.workspaceId)
      .eq('role', 'founder')
      .limit(1)
      .maybeSingle()
    if (!callerRow?.phone) {
      return { ok: false, error: 'Could not resolve your founder phone from the current workspace.' }
    }
    const founderPhone = callerRow.phone

    // Find matching customers (workspaces) by business name. Substring match.
    const { data: matches } = await supabase
      .from('customers')
      .select('id, business_name')
      .ilike('business_name', `%${needle}%`)
      .limit(5)

    const rows = (matches ?? []) as CustomerRow[]
    if (rows.length === 0) {
      return {
        ok: false,
        error: `No workspace found matching "${needle}". Try the exact business name.`,
      }
    }
    if (rows.length > 1) {
      return {
        ok: false,
        error: `Multiple workspaces match "${needle}" — be more specific.`,
        data: { candidates: rows.map((r) => r.business_name) },
      }
    }
    const target = rows[0]

    // Security gate: founder must have an allowlist row on the target.
    const { data: ownership } = await supabase
      .from('operator_allowlist')
      .select('id, role, verified_at')
      .eq('workspace_id', target.id)
      .eq('phone', founderPhone)
      .maybeSingle()
    if (!ownership || !ownership.verified_at || ownership.role !== 'founder') {
      return {
        ok: false,
        error: `You don't have founder access to ${target.business_name}.`,
      }
    }

    // Upsert the active-workspace pointer. Key shape includes phone so this
    // scales to multi-founder later without collision.
    const key = `founder_active_workspace_${founderPhone}`
    const { error: upsertErr } = await supabase
      .from('platform_settings')
      .upsert({ key, value: target.id, updated_at: new Date().toISOString() }, { onConflict: 'key' })
    if (upsertErr) return { ok: false, error: upsertErr.message }

    return {
      ok: true,
      data: {
        switched_to: target.business_name,
        workspace_id: target.id,
      },
    }
  },
}
