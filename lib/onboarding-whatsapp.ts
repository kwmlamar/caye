import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { SERVICE_BUSINESS_QUESTIONS, buildBusinessProfile, saveBusinessProfile } from '@/lib/onboarding'

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

const GREETING =
  "Hey! I'm Caye — your AI receptionist. I'll ask you 8 quick questions so I know exactly how to represent your business. Takes about 3 minutes. 🌴"

export function firstDiscoveryMessage(): string {
  return `${GREETING}\n\n${SERVICE_BUSINESS_QUESTIONS[0].question}`
}

/**
 * Advances the WhatsApp discovery grill by one turn: records `answerText`
 * against the current question, then either asks the next question or —
 * on the last question — synthesizes the business profile and flips the
 * workspace live.
 */
export async function handleDiscoveryAnswer(
  supabase: SupabaseClient,
  workspaceId: string,
  answerText: string
): Promise<{ replyText: string; completed: boolean }> {
  const { data: config } = await supabase
    .from('workspace_ai_config')
    .select('onboarding_wa_question_index, onboarding_wa_answers')
    .eq('workspace_id', workspaceId)
    .maybeSingle()

  const index = config?.onboarding_wa_question_index ?? 0
  const answers: Record<string, string> = { ...(config?.onboarding_wa_answers ?? {}) }

  const question = SERVICE_BUSINESS_QUESTIONS[index]
  if (!question) {
    // Shouldn't happen (would mean discovery already completed elsewhere),
    // but fail safe rather than throw on a live webhook.
    return {
      replyText: "Looks like we've already finished setup — text me anything and I'll help.",
      completed: true,
    }
  }

  answers[question.id] = answerText
  const nextIndex = index + 1
  const nextQuestion = SERVICE_BUSINESS_QUESTIONS[nextIndex]

  if (nextQuestion) {
    await supabase
      .from('workspace_ai_config')
      .update({ onboarding_wa_question_index: nextIndex, onboarding_wa_answers: answers })
      .eq('workspace_id', workspaceId)

    return { replyText: nextQuestion.question, completed: false }
  }

  // Last question answered — synthesize and go live.
  const { data: customer } = await supabase
    .from('customers')
    .select('business_name')
    .eq('id', workspaceId)
    .maybeSingle()

  const profile = await buildBusinessProfile(answers, customer?.business_name || 'your business')
  const { error: saveErr } = await saveBusinessProfile(workspaceId, profile, answers)

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

  return {
    replyText:
      "That's everything I need — I'm live and ready to represent your business. 🎉\n\n" +
      `One more step: connect the channels your customers message you on (WhatsApp, email, Instagram) here: ${connectUrl}\n\n` +
      "You can always come back and talk to me directly, anytime.",
    completed: true,
  }
}
