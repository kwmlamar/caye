import 'server-only'
import { randomUUID } from 'crypto'
import Anthropic from '@anthropic-ai/sdk'
import { createServiceClient } from '@/lib/supabase-server'
import type { VoiceProfile } from '@/lib/voice-profile'
import { loadAttentionDelta, renderAttentionContext } from '@/lib/owner-attention'
import { syncOwnerAttention } from '@/lib/owner-attention-sync'
import { businessTodayLabel } from '@/lib/booking-time'
import { loadOperatorContext, loadDirectThreadContext } from './context'
import { buildBackOfficeSystemPrompt } from './modes/back-office'
import { buildDriverSystemPrompt } from './modes/driver'
import { buildAdminShellSystemPrompt } from './modes/admin-shell'
import { loadAdminShellContext } from './admin-shell-context'
import { runToolLoop } from './execute'
import type { Role } from './tools/types'
import {
  loadAuthoritativeOwnerOperationalState,
  renderAuthoritativeOwnerOperationalState,
} from './owner-operational-state'

const DEFAULT_WORKSPACE_TIMEZONE = 'America/Nassau'
const MODEL = 'claude-sonnet-4-6'
const MAX_OUTPUT_TOKENS = 8192
const ADMIN_SHELL_PLACEHOLDER_WORKSPACE_ID = '00000000-0000-0000-0000-000000000000'

export type CayeAgentMode = 'front-desk' | 'back-office' | 'driver' | 'admin-shell'

export interface CayeAgentInput {
  mode: CayeAgentMode
  workspaceId: string
  userMessage: string | Anthropic.MessageParam['content']
  callerRole: Role
  callerName?: string | null
  operatorId: number | null
  callerPhone?: string | null
  origin?: 'chat' | 'scan'
  threadId?: string | null
}

export interface CayeAgentResult {
  replyText: string
  newTurns: Anthropic.MessageParam[]
  linkedThreadIds: string[]
}

async function reconciledAttention(workspaceId: string) {
  await syncOwnerAttention(workspaceId)
  return loadAttentionDelta({ workspaceId })
}

function textFromUserMessage(content: CayeAgentInput['userMessage']): string {
  if (typeof content === 'string') return content
  return content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .filter(Boolean)
    .join('\n')
}

export async function cayeAgent(input: CayeAgentInput): Promise<CayeAgentResult> {
  if (input.mode === 'driver') return runDriverAgent(input)
  if (input.mode === 'admin-shell') return runAdminShellAgent(input)
  if (input.mode !== 'back-office') {
    throw new Error(
      `[caye-agent] mode '${input.mode}' is not yet routed through the unified agent (see epic #35).`
    )
  }

  const supabase = createServiceClient()
  const { data: customer } = await supabase
    .from('customers')
    .select('business_name, full_name, ai_voice_profile, contact_email, contact_phone, whatsapp_business_number, timezone, business_hours, business_brief')
    .eq('id', input.workspaceId)
    .maybeSingle()

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
      operatorPersonalEmail = (extras.operator_personal_email as string | null) ?? null
      operatorPersonalPhone = (extras.operator_personal_phone as string | null) ?? null
      teamNotes = (extras.team_notes as string | null) ?? null
    }
  } catch {
    // Pre-migration environments may not have these columns yet.
  }

  const voiceProfile = (customer?.ai_voice_profile as VoiceProfile | null) ?? null
  const workspaceTimezone = (customer?.timezone as string | null) || DEFAULT_WORKSPACE_TIMEZONE
  const brief = (customer?.business_brief as Record<string, unknown> | null) ?? null
  const briefAddress = typeof brief?.address === 'string' ? brief.address : null
  const briefTagline = typeof brief?.tagline === 'string' ? brief.tagline : null
  const briefWebsite = typeof brief?.website === 'string' ? brief.website : null
  const briefAvailability = typeof brief?.availability === 'string' ? brief.availability : null
  const briefPaymentMethodsRaw = brief?.paymentMethods
  const briefPaymentMethods = Array.isArray(briefPaymentMethodsRaw)
    ? briefPaymentMethodsRaw.filter((m): m is string => typeof m === 'string')
    : null

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
  if (!businessHoursDisplay && briefAvailability) businessHoursDisplay = briefAvailability

  const threadCtx = input.threadId
    ? await loadDirectThreadContext(input.workspaceId, input.threadId)
    : null

  // CAY-103: consequential owner analysis gets current authoritative state
  // before the model reasons. The model no longer decides whether to call the
  // outreach status tool for these questions; current system-of-record facts
  // are pinned into the prompt ahead of history/memory/inference.
  const ownerOperationalContext = renderAuthoritativeOwnerOperationalState(
    await loadAuthoritativeOwnerOperationalState(
      input.workspaceId,
      textFromUserMessage(input.userMessage)
    )
  )

  const baseSystemPrompt = buildBackOfficeSystemPrompt({
    profile: {
      operatorName: (customer?.full_name as string | null) ?? null,
      businessName: (customer?.business_name as string | null) ?? null,
      tagline: briefTagline,
      website: briefWebsite,
      contactEmail: (customer?.contact_email as string | null) ?? null,
      contactPhone: (customer?.contact_phone as string | null) ?? null,
      whatsappBusinessNumber: (customer?.whatsapp_business_number as string | null) ?? null,
      businessAddress: briefAddress,
      operatorPersonalEmail,
      operatorPersonalPhone,
      teamNotes,
      businessHoursDisplay,
      paymentMethods: briefPaymentMethods,
      timezone: (customer?.timezone as string | null) ?? null,
    },
    businessTodayLabel: businessTodayLabel(workspaceTimezone),
    voiceProfile,
    caller: {
      role: input.callerRole,
      name: input.callerName ?? null,
    },
    origin: input.origin,
    attentionContext:
      input.origin === 'scan'
        ? renderAttentionContext(await reconciledAttention(input.workspaceId))
        : null,
    threadContext: threadCtx?.promptBlock ?? null,
  })

  const systemPrompt = ownerOperationalContext
    ? `${baseSystemPrompt}\n\n${ownerOperationalContext}`
    : baseSystemPrompt

  const history = threadCtx
    ? threadCtx.history
    : await loadOperatorContext(input.workspaceId, input.operatorId)
  const currentUserTurn: Anthropic.MessageParam = {
    role: 'user',
    content: input.userMessage,
  }
  const initialMessages: Anthropic.MessageParam[] = [...history, currentUserTurn]
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const directThreadLinks: string[] = []

  const { replyText, newTurns } = await runToolLoop({
    client,
    model: MODEL,
    maxTokens: MAX_OUTPUT_TOKENS,
    systemPrompt,
    initialMessages,
    ctx: {
      workspaceId: input.workspaceId,
      callerRole: input.callerRole,
      operatorId: input.operatorId,
      requestId: randomUUID(),
      origin: input.origin,
      directThreadLinks,
      workspaceTimezone,
    },
    mode: 'back-office',
  })

  return { replyText, newTurns, linkedThreadIds: [...new Set(directThreadLinks)] }
}

async function runDriverAgent(input: CayeAgentInput): Promise<CayeAgentResult> {
  const supabase = createServiceClient()
  const { data: customer } = await supabase
    .from('customers')
    .select('business_name, full_name')
    .eq('id', input.workspaceId)
    .maybeSingle()

  const systemPrompt = buildDriverSystemPrompt({
    businessName: (customer?.business_name as string | null) ?? (customer?.full_name as string | null) ?? null,
    driverName: input.callerName ?? null,
  })

  const history = await loadOperatorContext(input.workspaceId, input.operatorId)
  const initialMessages: Anthropic.MessageParam[] = [
    ...history,
    { role: 'user', content: input.userMessage },
  ]
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  const { replyText, newTurns } = await runToolLoop({
    client,
    model: MODEL,
    maxTokens: MAX_OUTPUT_TOKENS,
    systemPrompt,
    initialMessages,
    ctx: {
      workspaceId: input.workspaceId,
      callerRole: 'driver',
      callerPhone: input.callerPhone ?? null,
      operatorId: input.operatorId,
      requestId: randomUUID(),
    },
    mode: 'driver',
  })
  return { replyText, newTurns, linkedThreadIds: [] }
}

async function runAdminShellAgent(input: CayeAgentInput): Promise<CayeAgentResult> {
  const systemPrompt = buildAdminShellSystemPrompt({
    callerName: input.callerName ?? null,
  })
  const history = await loadAdminShellContext()
  const initialMessages: Anthropic.MessageParam[] = [
    ...history,
    { role: 'user', content: input.userMessage },
  ]
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  const { replyText, newTurns } = await runToolLoop({
    client,
    model: MODEL,
    maxTokens: MAX_OUTPUT_TOKENS,
    systemPrompt,
    initialMessages,
    ctx: {
      workspaceId: ADMIN_SHELL_PLACEHOLDER_WORKSPACE_ID,
      callerRole: 'founder',
      operatorId: null,
      requestId: randomUUID(),
    },
    mode: 'admin-shell',
  })
  return { replyText, newTurns, linkedThreadIds: [] }
}

export { loadOperatorContext } from './context'
export { buildBackOfficeSystemPrompt } from './modes/back-office'
export { buildDriverSystemPrompt } from './modes/driver'
export { buildAdminShellSystemPrompt } from './modes/admin-shell'
export { loadAdminShellContext } from './admin-shell-context'
