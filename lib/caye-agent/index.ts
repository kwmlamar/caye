import 'server-only'
import Anthropic from '@anthropic-ai/sdk'
import { createServiceClient } from '@/lib/supabase-server'
import type { VoiceProfile } from '@/lib/voice-profile'
import { loadOperatorContext } from './context'
import { buildBackOfficeSystemPrompt } from './modes/back-office'
import { runToolLoop } from './execute'
import type { Role } from './tools/types'

const MODEL = 'claude-sonnet-4-6'
const MAX_OUTPUT_TOKENS = 1024

export type CayeAgentMode = 'front-desk' | 'back-office'

export interface CayeAgentInput {
  mode: CayeAgentMode
  workspaceId: string
  userMessage: string
  /**
   * Caller's role from operator_allowlist (#48). Enforced per-tool in
   * runToolLoop. Webhook callers pass the looked-up role; cron paths
   * (briefings) bypass cayeAgent entirely and call runToolLoop directly
   * with callerRole: 'founder'.
   */
  callerRole: Role
  /**
   * Caller's display name from operator_allowlist.name when known. Used
   * by the back-office prompt to distinguish the actual messenger from
   * the workspace owner — load-bearing when a founder DMs into a
   * workspace they don't own (e.g. Lamar texting Caye about Bimini).
   * Without this, Caye conflates caller with workspace owner and answers
   * "who am I?" with the wrong person.
   */
  callerName?: string | null
}

export interface CayeAgentResult {
  /** Plain-text reply, ready to send to WhatsApp. Empty string if nothing useful was produced. */
  replyText: string
  /**
   * All new turns produced this round (intermediate assistant turns with
   * tool_use, intermediate user turns with tool_result, and the final
   * assistant text turn). Caller persists each to
   * `caye_operator_messages.claude_format` so the next sliding-window
   * load reconstructs the full Claude history.
   */
  newTurns: Anthropic.MessageParam[]
}

/**
 * Entry point for the unified Caye agent (epic #35).
 *
 * Slice #38 scope (this file):
 *   - mode: 'back-office' only
 *   - Tool-use loop with the read tools registered in tools/registry.ts
 *   - Sliding window context from caye_operator_messages
 *   - Returns every turn for the webhook to persist individually
 *
 * Front-desk mode still routes through lib/caye-reply.ts; the mode arg
 * is here to lock the API shape for later refactors.
 */
export async function cayeAgent(input: CayeAgentInput): Promise<CayeAgentResult> {
  if (input.mode !== 'back-office') {
    throw new Error(
      `[caye-agent] mode '${input.mode}' is not yet routed through the unified agent (see epic #35).`
    )
  }

  const supabase = createServiceClient()

  // Base query — only columns confirmed present in the production schema
  // as of 2026-06-22. The 20260622 migration adds operator_personal_email,
  // operator_personal_phone, and team_notes; until that's applied to a
  // given environment, those are fetched separately in a best-effort
  // pass below so this path still works.
  const { data: customer } = await supabase
    .from('customers')
    .select('business_name, full_name, ai_voice_profile, contact_email, contact_phone, whatsapp_business_number, timezone, business_hours, business_brief')
    .eq('id', input.workspaceId)
    .maybeSingle()

  // Best-effort fetch of the new operator-personal columns. Swallows
  // "column does not exist" errors so the back-office path keeps working
  // pre-migration. Once the migration is applied everywhere, merge this
  // into the main select.
  let operatorPersonalEmail: string | null = null
  let operatorPersonalPhone: string | null = null
  let teamNotes: string | null = null
  try {
    const { data: extras, error: extrasErr } = await supabase
      .from('customers')
      .select('operator_personal_email, operator_personal_phone, team_notes')
      .eq('id', input.workspaceId)
      .maybeSingle()
    if (!extrasErr && extras) {
      operatorPersonalEmail =
        (extras.operator_personal_email as string | null) ?? null
      operatorPersonalPhone =
        (extras.operator_personal_phone as string | null) ?? null
      teamNotes = (extras.team_notes as string | null) ?? null
    }
  } catch {
    // Pre-migration: columns don't exist. Leave the three values null.
  }

  const voiceProfile = (customer?.ai_voice_profile as VoiceProfile | null) ?? null

  // business_brief is the jsonb populated during onboarding (address,
  // tagline, website, payment methods, business hours availability text,
  // etc.) — we surface the slow-changing identity fields from it into
  // the prompt so Caye can answer "what's our address?" without a tool.
  const brief = (customer?.business_brief as Record<string, unknown> | null) ?? null
  const briefAddress = typeof brief?.address === 'string' ? brief.address : null
  const briefTagline = typeof brief?.tagline === 'string' ? brief.tagline : null
  const briefWebsite = typeof brief?.website === 'string' ? brief.website : null
  const briefAvailability =
    typeof brief?.availability === 'string' ? brief.availability : null
  const briefPaymentMethodsRaw = brief?.paymentMethods
  const briefPaymentMethods = Array.isArray(briefPaymentMethodsRaw)
    ? briefPaymentMethodsRaw.filter((m): m is string => typeof m === 'string')
    : null

  // Hours: prefer the structured business_hours jsonb if non-empty, else
  // fall back to the free-text availability blurb from business_brief.
  // We only format for display — full structured rendering lives in the
  // booking flow, not the operator prompt.
  let businessHoursDisplay: string | null = null
  if (customer?.business_hours && typeof customer.business_hours === 'object') {
    const entries = Object.entries(customer.business_hours as Record<string, unknown>)
    if (entries.length > 0) {
      businessHoursDisplay = entries
        .map(([day, val]) => {
          if (val && typeof val === 'object') {
            const v = val as { open?: unknown; close?: unknown }
            if (typeof v.open === 'string' && typeof v.close === 'string') {
              return `${day} ${v.open}-${v.close}`
            }
          }
          return null
        })
        .filter((s): s is string => !!s)
        .join(', ')
    }
  }
  if (!businessHoursDisplay && briefAvailability) {
    businessHoursDisplay = briefAvailability
  }

  const systemPrompt = buildBackOfficeSystemPrompt({
    profile: {
      operatorName: (customer?.full_name as string | null) ?? null,
      businessName: (customer?.business_name as string | null) ?? null,
      tagline: briefTagline,
      website: briefWebsite,
      contactEmail: (customer?.contact_email as string | null) ?? null,
      contactPhone: (customer?.contact_phone as string | null) ?? null,
      whatsappBusinessNumber:
        (customer?.whatsapp_business_number as string | null) ?? null,
      businessAddress: briefAddress,
      operatorPersonalEmail,
      operatorPersonalPhone,
      teamNotes,
      businessHoursDisplay,
      paymentMethods: briefPaymentMethods,
      timezone: (customer?.timezone as string | null) ?? null,
    },
    voiceProfile,
    caller: {
      role: input.callerRole,
      name: input.callerName ?? null,
    },
  })

  const history = await loadOperatorContext(input.workspaceId)
  const currentUserTurn: Anthropic.MessageParam = {
    role: 'user',
    content: input.userMessage,
  }
  const initialMessages: Anthropic.MessageParam[] = [...history, currentUserTurn]

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  const { replyText, newTurns } = await runToolLoop({
    client,
    model: MODEL,
    maxTokens: MAX_OUTPUT_TOKENS,
    systemPrompt,
    initialMessages,
    ctx: { workspaceId: input.workspaceId, callerRole: input.callerRole },
  })

  return { replyText, newTurns }
}

export { loadOperatorContext } from './context'
export { buildBackOfficeSystemPrompt } from './modes/back-office'
