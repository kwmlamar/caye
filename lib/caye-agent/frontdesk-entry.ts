import 'server-only'
import { randomUUID } from 'node:crypto'
import type Anthropic from '@anthropic-ai/sdk'
import { createServiceClient } from '@/lib/supabase-server'
import { runToolLoop } from './execute'
import { loadFrontDeskConversationContext } from './context'
import { loadRelationshipContext, loadOperationalContext } from './situation'
import { buildFrontDeskSituationSystemPrompt } from './modes/front-desk-situation'
import { persistFrontDeskAgentTurns } from '@/lib/caye-frontdesk-agent-turns'
import { enqueueHoldPing } from '@/lib/whatsapp/triggers'
import { authorizeAutonomousOutbound } from '@/lib/authorize-autonomous-outbound'
import { claimConversationExecution, releaseConversationExecution } from '@/lib/conversation-execution'

/**
 * frontdesk-entry.ts (2026-08-16, global Zoho cutover)
 *
 * The ONE real production entry point into the converged front-desk
 * runtime — the seam `app/api/webhooks/zoho-email/route.ts` calls instead
 * of `generateCayeAutoReply` for eligible (non-Sales) front-desk turns.
 *
 * Deliberately does NOT invent a new prompt architecture for email: it
 * assembles a real `CayeSituation` the same way replay/live-verification
 * did throughout the convergence work (loadFrontDeskConversationContext +
 * loadRelationshipContext + loadOperationalContext), passes `channel` as
 * whatever the calling webhook's actual channel is, and lets
 * `buildFrontDeskSituationSystemPrompt` render it. Email is a channel
 * value, not a different reasoning path.
 *
 * Ownership boundary: this function OWNS the customer-facing send (via
 * `send_customer_reply` → `dispatchOperatorReply`, called from inside the
 * tool loop) and OWNS persisting the resulting agent turns. The caller
 * (the webhook) does not additionally send anything or insert an outbound
 * `unified_messages` row for a turn this function handled — the tool
 * already did both, or correctly did neither (held).
 */

const DEFAULT_WORKSPACE_TIMEZONE = 'America/Nassau'

export interface ConvergedFrontDeskTurnInput {
  workspaceId: string
  conversationId: string
  /** The real, persisted unified_messages.id for the customer's inbound
   *  message that triggered this turn — NOT the provider's channel_message_id. */
  triggeringMessageId: string
  businessName: string | null
  channel: 'email' | 'whatsapp' | 'instagram' | 'messenger'
  contactId?: string | null
  contactName: string
  inboundBody: string
}

export type ConvergedFrontDeskOutcome = 'sent' | 'held' | 'error'

export interface ConvergedFrontDeskTurnResult {
  outcome: ConvergedFrontDeskOutcome
  toolsUsed: string[]
  usedOutputFallbackPath: boolean
  errorMessage?: string
  holdReason?: string
}

interface SendCustomerReplyToolResultData {
  sent?: boolean
  flagged_for_review?: boolean
}

function findSuccessfulSend(newTurns: Anthropic.MessageParam[]): SendCustomerReplyToolResultData | null {
  const resultsById = new Map<string, unknown>()
  for (const turn of newTurns) {
    if (typeof turn.content === 'string') continue
    for (const block of turn.content) {
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        const raw = typeof block.content === 'string' ? block.content : ''
        try {
          resultsById.set(block.tool_use_id, JSON.parse(raw))
        } catch {
          // Non-JSON tool_result content — not one of ours, ignore.
        }
      }
    }
  }
  for (const turn of newTurns) {
    if (typeof turn.content === 'string') continue
    for (const block of turn.content) {
      if (block.type === 'tool_use' && block.name === 'send_customer_reply') {
        const result = resultsById.get(block.id) as { ok?: boolean; data?: SendCustomerReplyToolResultData } | undefined
        if (result?.ok && result.data?.sent) return result.data
      }
    }
  }
  return null
}

function collectToolsUsed(newTurns: Anthropic.MessageParam[]): string[] {
  const names: string[] = []
  for (const turn of newTurns) {
    if (typeof turn.content === 'string') continue
    for (const block of turn.content) {
      if (block.type === 'tool_use') names.push(block.name)
    }
  }
  return names
}

export async function runConvergedFrontDeskTurn(
  input: ConvergedFrontDeskTurnInput
): Promise<ConvergedFrontDeskTurnResult> {
  const supabase = createServiceClient()
  let executionClaimId: string | null = null

  try {
    const authz = await authorizeAutonomousOutbound({
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      inboundBody: input.inboundBody,
    })
    if (!authz.allowed) {
      if (authz.reason === 'blocked_by_existing_hold') {
        const holdReason =
          'Conversation is already held for the owner — Caye will not reply autonomously until it is released.'
        return { outcome: 'held', toolsUsed: [], usedOutputFallbackPath: false, holdReason }
      }
      const holdReason =
        authz.reason === 'blocked_by_owner_policy'
          ? (authz.escalation?.internalContext ?? 'Owner-only standing rule matched — held for the owner.')
          : 'Caye could not verify whether this conversation is safe to answer automatically (an owner-authority check failed) — held for the owner.'
      await markHeld(supabase, input, holdReason)
      return { outcome: 'held', toolsUsed: [], usedOutputFallbackPath: false, holdReason }
    }

    const execution = await claimConversationExecution({
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      holder: 'autonomous_frontdesk',
      idempotencyKey: `frontdesk:${input.triggeringMessageId}`,
      triggeringMessageId: input.triggeringMessageId,
      reason: 'autonomous front-desk reply',
    })
    if (!execution.ok) {
      return {
        outcome: 'held', toolsUsed: [], usedOutputFallbackPath: false,
        holdReason: `Another customer-facing execution (${execution.blockedBy}) owns this conversation; autonomous Caye yielded.`,
      }
    }
    executionClaimId = execution.claim.id

    const [{ history: historyForModel }, relationshipCtx, operational, { data: customerRow }] = await Promise.all([
      loadFrontDeskConversationContext(input.conversationId),
      loadRelationshipContext(input.workspaceId, input.contactId ?? null),
      loadOperationalContext(input.workspaceId, 'front-desk'),
      supabase.from('customers').select('timezone').eq('id', input.workspaceId).maybeSingle(),
    ])
    const workspaceTimezone = (customerRow?.timezone as string | null) || DEFAULT_WORKSPACE_TIMEZONE

    if (historyForModel.length === 0) {
      throw new Error('loadFrontDeskConversationContext returned no history — the triggering inbound row is missing')
    }

    const situation = {
      channel: 'front-desk' as const,
      workspaceId: input.workspaceId,
      timezone: workspaceTimezone,
      now: new Date().toISOString(),
      history: historyForModel,
      historyTimestamps: historyForModel.map(() => null),
      historyForModel,
      relationship: relationshipCtx.relationship,
      workOpportunities: relationshipCtx.workOpportunities,
      operational,
    }

    const systemPrompt = buildFrontDeskSituationSystemPrompt({
      businessName: input.businessName,
      channel: input.channel,
      situation,
      toolsOffered: true,
    })

    const ctx = {
      workspaceId: input.workspaceId,
      callerRole: 'founder' as const,
      requestId: randomUUID(),
      conversationId: input.conversationId,
      triggeringMessageId: input.triggeringMessageId,
      executionClaimId: execution.claim.id,
      evidenceCollected: [],
    }

    const loopResult = await runToolLoop({
      model: 'claude-sonnet-4-6',
      maxTokens: 1536,
      systemPrompt,
      initialMessages: historyForModel,
      ctx,
      mode: 'front-desk',
    })

    const sendResult = findSuccessfulSend(loopResult.newTurns)
    const toolsUsed = collectToolsUsed(loopResult.newTurns)

    try {
      await persistFrontDeskAgentTurns(
        supabase,
        input.workspaceId,
        input.conversationId,
        input.triggeringMessageId,
        loopResult.newTurns
      )
    } catch (persistErr) {
      console.error(
        '[frontdesk-entry] agent-turn persistence failed (outcome below is unaffected):',
        persistErr instanceof Error ? persistErr.message : persistErr
      )
    }

    if (sendResult) {
      return { outcome: 'sent', toolsUsed, usedOutputFallbackPath: !!loopResult.usedOutputFallbackPath }
    }

    const holdReason = 'Caye (converged) could not answer with enough confidence — held for review.'
    await markHeld(supabase, input, holdReason)
    await releaseConversationExecution(execution.claim.id)
    return { outcome: 'held', toolsUsed, usedOutputFallbackPath: !!loopResult.usedOutputFallbackPath, holdReason }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[frontdesk-entry] converged runtime threw:', message)
    const holdReason = `Caye (converged) hit an error and could not process this message: ${message}`
    try {
      await markHeld(supabase, input, holdReason)
    } catch (holdErr) {
      console.error('[frontdesk-entry] also failed to record the fallback hold:', holdErr)
    }
    if (executionClaimId) {
      await releaseConversationExecution(executionClaimId).catch((releaseErr) => {
        console.error('[frontdesk-entry] also failed to release the execution claim:', releaseErr)
      })
    }
    return { outcome: 'error', toolsUsed: [], usedOutputFallbackPath: false, errorMessage: message, holdReason }
  }
}

async function markHeld(
  supabase: ReturnType<typeof createServiceClient>,
  input: ConvergedFrontDeskTurnInput,
  reason: string
): Promise<void> {
  const heldAt = new Date().toISOString()
  await supabase
    .from('unified_conversations')
    .update({
      human_agent_enabled: true,
      human_agent_reason: reason,
      human_agent_marked_at: heldAt,
    })
    .eq('id', input.conversationId)

  // This is an operator/internal audit record, not an outbound delivery.
  await supabase.from('unified_messages').insert({
    conversation_id: input.conversationId,
    channel_message_id: null,
    sender_type: 'business',
    content: reason,
    message_type: 'text',
    sent_at: heldAt,
    status: 'internal',
    is_internal: true,
    metadata: {
      generated_by: 'caye',
      hold_reason: reason,
      runtime: 'converged_frontdesk',
      audience: 'internal',
      message_kind: 'hold_notice',
    },
  })

  await enqueueHoldPing({
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    contactName: input.contactName,
    reason,
    inboundBody: input.inboundBody,
  }).catch((err) => console.error('[frontdesk-entry] enqueueHoldPing failed:', err))
}
