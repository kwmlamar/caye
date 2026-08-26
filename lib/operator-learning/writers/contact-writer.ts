import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { normalizeE164 } from '@/lib/caye-agent/tools/write-low/add-team-member'
import { sendTemplateWhatsApp } from '@/lib/whatsapp/outbound'
import type { ClassificationResult } from '../schema'
import type { WriteOutcome } from './types'

/**
 * writers/contact-writer.ts
 *
 * Routes to operator_allowlist — never to business_facts prose (routing
 * hard rule #2). Preserves the SAME consent gate add_team_member already
 * enforces: the row is written with verified_at=null, inert until the
 * contact themselves replies OK. A phone number sitting in this table with
 * no consent yet is not "learned knowledge Caye acts on" — it is exactly as
 * inert as if the owner had called add_team_member herself.
 *
 * Deliberately narrower than add_team_member: only handles first-time
 * addition (mirrors the one Bimini fixture this covers — "Max is the
 * driver, his number is X"). A phone-number CORRECTION for an existing
 * contact is not attempted here — operator_allowlist has no natural
 * single-column identity for "same person, new number" the way
 * canonical_key gives business_facts, so that case is held as a candidate
 * rather than guessed at. See the PR description for this as a known
 * follow-up.
 */
export async function writeContact(args: {
  workspaceId: string
  callerRole: string
  classification: ClassificationResult
}): Promise<WriteOutcome> {
  const payload = args.classification.contact
  if (!payload) return { decision: 'error', reason: 'destination contact but no contact payload' }

  const phone = normalizeE164(payload.phone)
  if (!phone) return { decision: 'candidate', reason: `"${payload.phone}" did not normalize to a valid phone number` }

  const supabase = createServiceClient()

  const { data: existing, error: lookupErr } = await supabase
    .from('operator_allowlist')
    .select('id, role, verified_at, phone')
    .eq('workspace_id', args.workspaceId)
    .eq('phone', phone)
    .maybeSingle()
  if (lookupErr) return { decision: 'error', reason: `allowlist lookup failed: ${lookupErr.message}` }

  if (existing) {
    // Idempotent: the same phone already on the allowlist — most likely a
    // duplicate webhook delivery of the same correction, or the owner
    // restating something already captured. Nothing new to do.
    return { decision: 'no_op', reason: `${phone} is already on the allowlist as ${existing.role}` }
  }

  const OTP_TTL_MS = 24 * 60 * 60 * 1000
  const expiresAt = new Date(Date.now() + OTP_TTL_MS).toISOString()
  const isDriver = payload.role === 'driver'

  let templateName: 'caye_driver_consent' | 'caye_team_consent' | 'caye_otp' = isDriver
    ? 'caye_driver_consent'
    : 'caye_team_consent'
  let code = 'OK'
  if (!isDriver) {
    const { data: teamConsentTemplate } = await supabase
      .from('whatsapp_templates')
      .select('status')
      .eq('name', 'caye_team_consent')
      .maybeSingle()
    if (teamConsentTemplate?.status !== 'approved') {
      templateName = 'caye_otp'
      code = String(Math.floor(100000 + Math.random() * 900000))
    }
  }

  const { data: inserted, error: insErr } = await supabase
    .from('operator_allowlist')
    .insert({
      workspace_id: args.workspaceId,
      phone,
      role: payload.role,
      name: payload.name,
      verified_at: null,
      pending_otp_code: code,
      pending_otp_expires_at: expiresAt,
      added_by: args.callerRole,
    })
    .select('id')
    .single()
  if (insErr) return { decision: 'error', reason: `allowlist insert failed: ${insErr.message}` }

  let placeholders = [code]
  if (templateName !== 'caye_otp') {
    const { data: business } = await supabase
      .from('customers')
      .select('business_name, full_name')
      .eq('id', args.workspaceId)
      .maybeSingle()
    const businessName = business?.business_name?.trim() || business?.full_name?.trim() || 'the business'
    placeholders = [payload.name, businessName]
  }

  const sent = await sendTemplateWhatsApp(
    phone,
    templateName,
    placeholders,
    `team-add-router-${args.workspaceId}-${phone}-${Date.now()}`
  )
  if (sent.status !== 'sent') {
    console.error('[operator-learning/contact-writer] verification template failed:', sent)
  }

  return {
    decision: 'written',
    targetTable: 'operator_allowlist',
    targetRecordId: inserted?.id ?? '',
    supersededRecordId: null,
    reason: `added ${payload.name} (${payload.role}) to the allowlist, inert until they reply OK`,
  }
}
