import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import {
  FIRST_DISCOVERY_QUESTION,
  MAX_DISCOVERY_QUESTIONS,
  decideNextDiscoveryStep,
  buildBusinessProfile,
  saveBusinessProfile,
  type DiscoveryTurn,
} from '@/lib/onboarding'

type SupabaseClient = ReturnType<typeof createServiceClient>

export function normalizeE164(phone: string): string {
  return phone.replace(/^\+/, '').replace(/\D/g, '')
}

// Signup deep-links carry the workspace id as a trailing run of
// zero-width characters appended to the friendly prefilled WhatsApp
// message (see /onboarding page) — invisible in the chat UI, but intact
// in the message body so a first-contact message from an unrecognized
// phone can be tied back to the workspace that generated the link.
// First-claim-wins: once a workspace has a verified owner row, the code
// is inert (tryAutoProvisionOwner below no-ops).
//
// Encoding: each hex nibble of the UUID (dashes stripped, 32 nibbles) is
// 4 bits, each bit mapped to one of two zero-width characters. 128
// invisible characters total — negligible size, invisible to the eye,
// untouched by WhatsApp's plain-text rendering.
const ZW = ['​', '‌'] // zero-width space (0) / zero-width non-joiner (1)
const ZW_RUN_RE = new RegExp(`[${ZW[0]}${ZW[1]}]{128}$`)

export function encodeSignupCode(workspaceId: string): string {
  const hex = workspaceId.replace(/-/g, '')
  return hex
    .split('')
    .map((ch) => {
      const nibble = parseInt(ch, 16)
      return [3, 2, 1, 0].map((bit) => ZW[(nibble >> bit) & 1]).join('')
    })
    .join('')
}

export function extractSignupCode(body: string): string | null {
  const match = body.match(ZW_RUN_RE)
  if (!match) return null

  const bits = match[0].split('').map((ch) => (ch === ZW[1] ? '1' : '0'))
  let hex = ''
  for (let i = 0; i < bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4).join(''), 2).toString(16)
  }
  if (!/^[0-9a-f]{32}$/.test(hex)) return null

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export interface ProvisionedOwner {
  id: string
  workspace_id: string
  role: 'owner'
  name: string | null
  verified_at: string
}

/**
 * Claims owner access for a phone number that just messaged Caye with a
 * signup code from the onboarding handoff screen. Returns null if the
 * code doesn't match an eligible workspace (already onboarded, already
 * claimed, or doesn't exist) — callers should fall back to the normal
 * "no allowlist entry" behavior in that case.
 */
export async function tryAutoProvisionOwner(
  supabase: SupabaseClient,
  workspaceId: string,
  normalizedPhone: string
): Promise<ProvisionedOwner | null> {
  const { data: config } = await supabase
    .from('workspace_ai_config')
    .select('workspace_id, system_prompt')
    .eq('workspace_id', workspaceId)
    .maybeSingle()

  // No config row yet is fine (brand new signup) — only a completed
  // discovery (system_prompt set) makes the code inert.
  if (config?.system_prompt) return null

  const { data: existingOwner } = await supabase
    .from('operator_allowlist')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('role', 'owner')
    .not('verified_at', 'is', null)
    .maybeSingle()

  if (existingOwner) return null

  const { data: customer } = await supabase
    .from('customers')
    .select('id, business_name')
    .eq('id', workspaceId)
    .maybeSingle()

  if (!customer) return null

  const now = new Date().toISOString()
  const { data: inserted, error } = await supabase
    .from('operator_allowlist')
    .upsert(
      {
        workspace_id: workspaceId,
        phone: `+${normalizedPhone}`,
        role: 'owner',
        name: customer.business_name ?? null,
        verified_at: now,
      },
      { onConflict: 'workspace_id,phone' }
    )
    .select('id, workspace_id, role, name, verified_at')
    .single()

  if (error || !inserted) {
    console.error('[onboarding-whatsapp] auto-provision failed:', error)
    return null
  }

  // Ensure workspace_ai_config exists so downstream reads (question
  // index, answers) have a row to update.
  await supabase
    .from('workspace_ai_config')
    .upsert({ workspace_id: workspaceId }, { onConflict: 'workspace_id', ignoreDuplicates: true })

  return inserted as ProvisionedOwner
}

/**
 * Creates a brand-new workspace from a WhatsApp-first signup: a phone
 * number Caye has never seen before, with no signup code (not an OAuth
 * handoff), just messaged her directly. No web form, no OAuth — texting
 * Caye first *is* signing up. Verified immediately since they just
 * proved phone ownership by sending the message.
 */
export async function tryColdStartWorkspace(
  supabase: SupabaseClient,
  normalizedPhone: string
): Promise<ProvisionedOwner | null> {
  const workspaceId = crypto.randomUUID()
  const now = new Date().toISOString()

  const { error: customerError } = await supabase.from('customers').insert({
    id: workspaceId,
    business_name: null,
    contact_email: null,
    full_name: null,
    plan: 'free',
    status: 'trial',
  })

  if (customerError) {
    console.error('[onboarding-whatsapp] cold-start customer insert failed:', customerError)
    return null
  }

  const { data: inserted, error: allowlistError } = await supabase
    .from('operator_allowlist')
    .insert({
      workspace_id: workspaceId,
      phone: `+${normalizedPhone}`,
      role: 'owner',
      name: null,
      verified_at: now,
    })
    .select('id, workspace_id, role, name, verified_at')
    .single()

  if (allowlistError || !inserted) {
    console.error('[onboarding-whatsapp] cold-start allowlist insert failed:', allowlistError)
    return null
  }

  await supabase
    .from('workspace_ai_config')
    .upsert({ workspace_id: workspaceId }, { onConflict: 'workspace_id', ignoreDuplicates: true })

  return inserted as ProvisionedOwner
}

const GREETING =
  "Hey! I'm Caye — your AI receptionist. I'll ask a few quick questions about your business — I'll keep it as short as I can. 🌴"

export function firstDiscoveryMessage(): string {
  return `${GREETING}\n\n${FIRST_DISCOVERY_QUESTION}`
}

/**
 * Advances the WhatsApp discovery grill by one turn: records `answerText`
 * against the question Caye last asked, then either asks the next
 * adaptively-chosen question or — once there's enough, or the question
 * cap is hit — synthesizes the business profile and flips the workspace
 * live. See lib/onboarding.ts:decideNextDiscoveryStep for how "enough" is
 * decided; this is grill-me-style (one question at a time, stop as soon
 * as there's enough), not a fixed script.
 */
export async function handleDiscoveryAnswer(
  supabase: SupabaseClient,
  workspaceId: string,
  answerText: string
): Promise<{ replyText: string; completed: boolean }> {
  const { data: config } = await supabase
    .from('workspace_ai_config')
    .select('onboarding_wa_answers, onboarding_wa_last_question')
    .eq('workspace_id', workspaceId)
    .maybeSingle()

  const turns: DiscoveryTurn[] = config?.onboarding_wa_answers ?? []

  let newTurns: DiscoveryTurn[]
  if (turns.length === 0) {
    // No prior turns means this answer is necessarily the reply to the
    // fixed business-name question — always asked first, deterministically.
    newTurns = [{ question: FIRST_DISCOVERY_QUESTION, answer: answerText }]
    // Persisted immediately (rather than waiting for saveBusinessProfile
    // at the end) so it's available right away — operator_allowlist.name,
    // the founder dashboard, and buildBusinessProfile's businessName arg
    // all read customers.business_name directly.
    await supabase.from('customers').update({ business_name: answerText }).eq('id', workspaceId)
  } else {
    const lastQuestion = config?.onboarding_wa_last_question ?? FIRST_DISCOVERY_QUESTION
    newTurns = [...turns, { question: lastQuestion, answer: answerText }]
  }

  const { data: customer } = await supabase
    .from('customers')
    .select('business_name')
    .eq('id', workspaceId)
    .maybeSingle()
  const businessName = customer?.business_name || 'your business'

  const atCap = newTurns.length >= MAX_DISCOVERY_QUESTIONS
  const step = atCap ? { done: true as const } : await decideNextDiscoveryStep(businessName, newTurns)

  if (!step.done) {
    await supabase
      .from('workspace_ai_config')
      .update({
        onboarding_wa_question_index: newTurns.length,
        onboarding_wa_answers: newTurns,
        onboarding_wa_last_question: step.question,
      })
      .eq('workspace_id', workspaceId)

    const replyText = step.suggestedAnswer
      ? `${step.question}\n\n(e.g. "${step.suggestedAnswer}")`
      : step.question

    return { replyText, completed: false }
  }

  // Enough to go on (or hit the cap) — synthesize and go live.
  let profile
  try {
    profile = await buildBusinessProfile(newTurns, businessName)
  } catch (err) {
    console.error('[onboarding-whatsapp] buildBusinessProfile failed:', err)
    return {
      replyText:
        "I hit a snag putting your profile together — mind sending your last answer again in a moment? If it keeps happening, tell me and I'll flag it.",
      completed: false,
    }
  }

  const { error: saveErr } = await saveBusinessProfile(workspaceId, profile, newTurns)

  if (saveErr) {
    console.error('[onboarding-whatsapp] saveBusinessProfile failed:', saveErr)
    return {
      replyText:
        "I hit a snag saving your profile — mind sending your last answer again in a moment? If it keeps happening, tell me and I'll flag it.",
      completed: false,
    }
  }

  await supabase
    .from('workspace_ai_config')
    .update({ whatsapp_outbound_enabled: true })
    .eq('workspace_id', workspaceId)

  const connectUrl = `${process.env.NEXT_PUBLIC_APP_URL || ''}/connect?ws=${workspaceId}`
  const claimUrl = `${process.env.NEXT_PUBLIC_APP_URL || ''}/login?ws=${workspaceId}`

  return {
    replyText:
      "That's everything I need — I'm live and ready to represent your business. 🎉\n\n" +
      `One more step: connect the channels your customers message you on (WhatsApp, email, Instagram) here: ${connectUrl}\n\n` +
      `Want a dashboard too, for billing and settings? Sign in here anytime: ${claimUrl}\n\n` +
      "You can always come back and talk to me directly, anytime.",
    completed: true,
  }
}
