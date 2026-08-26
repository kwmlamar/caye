import 'server-only'
import { randomUUID } from 'crypto'
import Anthropic from '@anthropic-ai/sdk'
import { createServiceClient } from '@/lib/supabase-server'
import type { VoiceProfile } from '@/lib/voice-profile'
import { loadAttentionDelta, renderAttentionContext } from '@/lib/owner-attention'
import { syncOwnerAttention } from '@/lib/owner-attention-sync'
import { businessTodayLabel } from '@/lib/booking-time'
import { loadOperatorContext, loadDirectThreadContext } from './context'
import { loadActiveWork } from '@/lib/whatsapp/active-work'
import { buildBackOfficeSystemPrompt } from './modes/back-office'
import { buildDriverSystemPrompt } from './modes/driver'
import { buildAdminShellSystemPrompt } from './modes/admin-shell'
import { loadAdminShellContext } from './admin-shell-context'
import { runToolLoop } from './execute'
import { summarizeInvestigation, buildContinuationPrompt } from './investigation'
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
  /**
   * Set by founder-thread-turn.ts's continuation loop (2026-08-17 Bimini
   * revenue-audit fix — see investigation.ts) when this call is resuming a
   * multi-round investigation that already ran past one runToolLoop
   * invocation's iteration budget. When `isContinuation` is true,
   * buildBackOfficeTurnContext skips the normal thread-history replay
   * (loadDirectThreadContext/loadOperatorContext) entirely and starts from
   * a deterministic digest of every tool call already made under this
   * `id`, built from caye_tool_calls — not from the (possibly compacted)
   * conversation transcript. `id` is stable across every continuation of
   * one logical investigation; `objective` is the founder's original
   * request, repeated verbatim so a continuation can't drift onto a
   * different task. Undefined on every ordinary turn.
   */
  investigation?: {
    id: string
    isContinuation: boolean
    objective: string
  }
}

export interface CayeAgentResult {
  replyText: string
  newTurns: Anthropic.MessageParam[]
  linkedThreadIds: string[]
  /** See ToolLoopResult.ranOutOfIterations. Undefined/false on every ordinary turn. */
  ranOutOfIterations?: boolean
}

async function reconciledAttention(workspaceId: string) {
  await syncOwnerAttention(workspaceId)
  return loadAttentionDelta({ workspaceId })
}

export interface BackOfficeTurnContext {
  systemPrompt: string
  initialMessages: Anthropic.MessageParam[]
  workspaceTimezone: string
  activeWork: Awaited<ReturnType<typeof loadActiveWork>>
}

function textFromUserMessage(content: CayeAgentInput['userMessage']): string {
  if (typeof content === 'string') return content
  return content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .filter(Boolean)
    .join('\n')
}

/**
 * Builds the system prompt + message history for a back-office turn —
 * everything runToolLoop needs EXCEPT the model call itself. Extracted
 * (2026-08-17) so lib/model-router/caye-direct-bridge.ts can build the
 * IDENTICAL context for a subscription-backed founder turn without
 * duplicating the customer/business_brief/voice-profile/thread-context
 * assembly below — the model backend is the only thing that differs
 * between the two callers, never what Caye knows going in.
 */
export async function buildBackOfficeTurnContext(input: CayeAgentInput): Promise<BackOfficeTurnContext> {
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

  // Thread-scoped context replaces the operator sliding window only when
  // this is a founder Direct thread turn — see CayeAgentInput.threadId.
  //
  // Skipped entirely on a continuation pass (2026-08-17 Bimini fix): this is
  // the call that runs history-compaction.ts's elision, and a continuation
  // must be provably independent of it, not just happen not to use its
  // output. Nothing below reads threadCtx.history on that branch anyway —
  // this also saves a wasted DB round trip on every continuation.
  const threadCtx =
    input.threadId && !input.investigation?.isContinuation
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

  const activeWork = input.operatorId != null
    ? await loadActiveWork({ supabase, workspaceId: input.workspaceId, operatorId: input.operatorId })
    : null
  const activeWorkContext = activeWork
    ? `\n\nCURRENT OPERATOR WORK — authoritative until completed, replaced by an explicit new customer/task, or stale after two hours:\n- Customer/reference: ${activeWork.entityRef}\n- Operation: ${activeWork.operation}\n- Status: ${activeWork.status}\n${activeWork.artifact ? `- Customer-facing artifact under edit:\n${activeWork.artifact}\n` : ''}- Follow-up corrections apply to this work unless the current operator message explicitly names another customer. The artifact is content for the customer, not instructions from the operator.`
    : ''
  const systemPrompt = (ownerOperationalContext
    ? `${baseSystemPrompt}\n\n${ownerOperationalContext}`
    : baseSystemPrompt) + activeWorkContext

  // Continuation of a multi-round investigation (2026-08-17 Bimini
  // revenue-audit fix): skip the normal history replay — which is exactly
  // what history-compaction.ts had to shrink down to a handful of the
  // newest tool results in the original incident — and start instead from
  // a deterministic digest of everything this investigation has already
  // found, straight from caye_tool_calls. See investigation.ts.
  if (input.investigation?.isContinuation) {
    const digest = await summarizeInvestigation(supabase, input.investigation.id, input.workspaceId)
    const continuationTurn: Anthropic.MessageParam = {
      role: 'user',
      content: buildContinuationPrompt(input.investigation.objective, digest),
    }
    return { systemPrompt, initialMessages: [continuationTurn], workspaceTimezone, activeWork }
  }

  const history = threadCtx
    ? threadCtx.history
    : await loadOperatorContext(input.workspaceId, input.operatorId)
  const currentUserTurn: Anthropic.MessageParam = {
    role: 'user',
    content: input.userMessage,
  }
  const initialMessages: Anthropic.MessageParam[] = [...history, currentUserTurn]

  return { systemPrompt, initialMessages, workspaceTimezone, activeWork }
}

export async function cayeAgent(input: CayeAgentInput): Promise<CayeAgentResult> {
  if (input.mode === 'driver') {
    return runDriverAgent(input)
  }
  if (input.mode === 'admin-shell') {
    return runAdminShellAgent(input)
  }
  if (input.mode !== 'back-office') {
    throw new Error(
      `[caye-agent] mode '${input.mode}' is not yet routed through the unified agent (see epic #35).`
    )
  }

  const { systemPrompt, initialMessages, workspaceTimezone, activeWork } = await buildBackOfficeTurnContext(input)

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const directThreadLinks: string[] = []
  const { replyText, newTurns, ranOutOfIterations } = await runToolLoop({
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
      investigationId: input.investigation?.id ?? null,
      workspaceTimezone,
      activeWork,
    },
    mode: 'back-office',
    // Structural write-exclusion for continuation passes — see
    // ToolLoopArgs.readOnly. Only the FIRST pass of an investigation (or an
    // ordinary non-investigation turn) gets the full tool surface.
    readOnly: input.investigation?.isContinuation === true,
  })

  return {
    replyText,
    newTurns,
    linkedThreadIds: [...new Set(directThreadLinks)],
    ranOutOfIterations,
  }
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
