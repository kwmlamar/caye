import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { Tool } from '../../types'

interface SetWorkspaceAutonomyInput {
  workspace: string
  opportunity_scan_enabled?: boolean
  business_insights_enabled?: boolean
}

/**
 * Turn Caye's proactive crons on or off for one workspace. Registered
 * pre-wrapped with gateAdminHighRisk in registry.ts — this raw execute() is
 * only ever reached on the SECOND (confirming) call.
 *
 * Why HIGH-risk for what is literally a boolean flip: enabling
 * opportunity_scan_enabled is what makes Caye start running unprompted agent
 * turns against a live customer's workspace three times a day and messaging
 * that customer's owner on WhatsApp. It's the single largest expansion of
 * autonomous surface area available anywhere in the product, and it lands on
 * a paying customer's phone rather than the founder's. An accidental flip is
 * outward-facing and can't be un-sent, which is exactly the bar gateHighRisk
 * exists for — the flag being cheap to write says nothing about what it
 * costs to have written it.
 *
 * Deliberately admin-shell-only. Back-office (including the opportunity scan
 * itself, which runs mode: 'back-office' with callerRole 'founder') never
 * sees this tool because runToolLoop filters by mode — so a scan can never
 * widen its own blast radius or switch itself on for another workspace.
 */
export const setWorkspaceAutonomy: Tool<SetWorkspaceAutonomyInput> = {
  name: 'set_workspace_autonomy',
  description:
    "Turn a workspace's proactive Caye crons on or off: opportunity-scan (she reviews that workspace 3x/day on her own and WhatsApps the owner what needs attention) and/or business-insights (weekly performance read-out). Founder-only. Match the workspace by business name — substring, case-insensitive (\"bimini\" matches \"Bimini Island Tours\"). Call get_workspace_autonomy first to see current state; only pass the flags you actually want to change. HIGH-RISK — enabling opportunity-scan means Caye starts messaging that customer's owner unprompted, so confirmation is enforced in code: the first call only stages the change, then relay the summary and call again with identical arguments once the founder confirms in a NEW message.",
  risk: 'high',
  roles: ['founder'],
  modes: ['admin-shell'],
  inputSchema: {
    type: 'object',
    properties: {
      workspace: {
        type: 'string',
        description: 'Business name to match against customers.business_name (substring, case-insensitive).',
      },
      opportunity_scan_enabled: {
        type: 'boolean',
        description: 'Set the 3x/day proactive workspace scan on or off. Omit to leave unchanged.',
      },
      business_insights_enabled: {
        type: 'boolean',
        description: 'Set the weekly business-insights read-out on or off. Omit to leave unchanged.',
      },
    },
    required: ['workspace'],
  },

  async execute(args) {
    if (args.opportunity_scan_enabled === undefined && args.business_insights_enabled === undefined) {
      return { ok: false, error: 'Nothing to change — pass at least one flag.' }
    }

    const needle = args.workspace.trim()
    if (needle.length < 2) {
      return { ok: false, error: 'Workspace name is too short — give me more to match on.' }
    }

    const supabase = createServiceClient()
    const { data: matches, error: matchErr } = await supabase
      .from('customers')
      .select('id, business_name')
      .ilike('business_name', `%${needle}%`)
      .limit(5)
    if (matchErr) return { ok: false, error: matchErr.message }

    const found = (matches ?? []) as Array<{ id: string; business_name: string | null }>
    if (found.length === 0) return { ok: false, error: `No workspace matches "${needle}".` }
    if (found.length > 1) {
      return {
        ok: false,
        error: `"${needle}" matches ${found.length} workspaces — be more specific.`,
        data: { matches: found.map((m) => m.business_name) },
      }
    }

    const target = found[0]
    const patch: Record<string, boolean> = {}
    if (args.opportunity_scan_enabled !== undefined) {
      patch.opportunity_scan_enabled = args.opportunity_scan_enabled
    }
    if (args.business_insights_enabled !== undefined) {
      patch.business_insights_enabled = args.business_insights_enabled
    }

    const { data: updated, error } = await supabase
      .from('workspace_ai_config')
      .update(patch)
      .eq('workspace_id', target.id)
      .select(
        'opportunity_scan_enabled, business_insights_enabled, whatsapp_outbound_enabled, operator_whatsapp_number'
      )
      .maybeSingle()

    if (error) return { ok: false, error: error.message }
    if (!updated) {
      return { ok: false, error: `${target.business_name} has no workspace_ai_config row yet — nothing to update.` }
    }

    // Enabling a cron on a workspace the cron will then skip is a silent
    // no-op the founder would otherwise only discover by waiting for a ping
    // that never comes. Surface it in the same breath as the success.
    const turnedSomethingOn =
      args.opportunity_scan_enabled === true || args.business_insights_enabled === true
    const deliverable = updated.whatsapp_outbound_enabled === true && !!updated.operator_whatsapp_number

    return {
      ok: true,
      data: {
        workspace: target.business_name,
        workspace_id: target.id,
        opportunity_scan_enabled: updated.opportunity_scan_enabled,
        business_insights_enabled: updated.business_insights_enabled,
        ...(turnedSomethingOn && !deliverable
          ? {
              warning: !updated.operator_whatsapp_number
                ? 'Enabled, but this workspace has no operator_whatsapp_number — the cron will skip it every tick until one is set.'
                : 'Enabled, but whatsapp_outbound_enabled is false — the cron will skip it every tick until outbound is on.',
            }
          : {}),
      },
    }
  },
}
