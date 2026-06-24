import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { sendTemplateWhatsApp } from '@/lib/whatsapp/outbound'
import type { Tool } from '../types'

interface AddTeamMemberInput {
  name: string
  phone: string
  role: 'owner' | 'staff'
}

const OTP_TTL_MS = 24 * 60 * 60 * 1000 // 24h — generous; member may not see it for a while

function normalizeE164(raw: string): string | null {
  const digits = raw.replace(/\D/g, '')
  if (digits.length < 8) return null
  return `+${digits}`
}

export const addTeamMember: Tool<AddTeamMemberInput> = {
  name: 'add_team_member',
  description:
    "Add a teammate so they can talk to Caye from their own WhatsApp. Use when the owner says " +
    "\"add Max, his number is +1242XXXXXXX, role owner\".\n\n" +
    "Roles:\n" +
    "- owner: full back-office access (same as the workspace owner).\n" +
    "- staff: schema-only in v1 — the row is created but no tool currently grants staff access. " +
    "Set it anyway when the owner specifies it; future tools will pick it up automatically.\n" +
    "(founder is auto-assigned, never set via this tool.)\n\n" +
    "Caye sends the new member a verification code via WhatsApp template. They reply with the " +
    "code, then they're live. Until they verify, their messages to Caye are dropped — so the " +
    "owner can safely add a wrong number without it actually granting access.",
  risk: 'low',
  roles: ['owner', 'founder'],
  modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Display name (e.g. "Max"). Stored for owner reference.' },
      phone: { type: 'string', description: 'Phone number — any E.164-ish format works.' },
      role: { type: 'string', enum: ['owner', 'staff'], description: 'Permission tier.' },
    },
    required: ['name', 'phone', 'role'],
  },

  async execute(args, ctx) {
    const phone = normalizeE164(args.phone)
    if (!phone) return { ok: false, error: 'Phone number is not valid.' }
    const name = args.name.trim()
    if (name.length < 1) return { ok: false, error: 'Name is required.' }

    const supabase = createServiceClient()

    const { data: existing } = await supabase
      .from('operator_allowlist')
      .select('id, role, verified_at')
      .eq('workspace_id', ctx.workspaceId)
      .eq('phone', phone)
      .maybeSingle()
    if (existing) {
      return {
        ok: false,
        error: `${phone} is already on the allowlist as ${existing.role} (${existing.verified_at ? 'verified' : 'pending verification'}).`,
      }
    }

    const code = String(Math.floor(100000 + Math.random() * 900000))
    const expiresAt = new Date(Date.now() + OTP_TTL_MS).toISOString()

    const { error: insErr } = await supabase.from('operator_allowlist').insert({
      workspace_id: ctx.workspaceId,
      phone,
      role: args.role,
      name,
      verified_at: null,
      pending_otp_code: code,
      pending_otp_expires_at: expiresAt,
      added_by: ctx.callerRole,
    })
    if (insErr) return { ok: false, error: insErr.message }

    // Fire the OTP template. Failure leaves the row in place — owner can
    // re-trigger with update_team_member_permissions later, or remove + re-add.
    const sent = await sendTemplateWhatsApp(
      phone,
      'caye_otp',
      [code],
      `team-add-${ctx.workspaceId}-${phone}-${Date.now()}`
    )
    const sendOk = sent.status === 'sent'
    if (!sendOk) {
      console.error('[add-team-member] OTP template failed:', sent)
    }

    return {
      ok: true,
      data: {
        name,
        phone,
        role: args.role,
        verification_sent: sendOk,
        verification_error: sendOk ? null : sent.error ?? 'unknown',
        note: 'Member is on the allowlist but inert until they reply to Caye with the verification code.',
      },
    }
  },
}
