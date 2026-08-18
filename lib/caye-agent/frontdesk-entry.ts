import 'server-only'
import { randomUUID } from 'node:crypto'
import Anthropic from '@anthropic-ai/sdk'
import { createServiceClient } from '@/lib/supabase-server'
import { runToolLoop } from './execute'
import { loadFrontDeskConversationContext } from './context'
import { loadRelationshipContext, loadOperationalContext } from './situation'
import { buildFrontDeskSituationSystemPrompt } from './modes/front-desk-situation'
import { persistFrontDeskAgentTurns } from '@/lib/caye-frontdesk-agent-turns'
import { enqueueHoldPing } from '@/lib/whatsapp/triggers'
import { authorizeAutonomousOutbound } from '@/lib/authorize-autonomous-outbound'

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

export interface ConvergedFrontDeskTurnInput {
  workspaceId: string
  conversationId: string
  /** The real, persisted unified_messages.id for the customer's inbound
   *  message that triggered this turn — NOT the provider's channel_message_id.
   *  Required for both send idempotency (dispatchOperatorReply) and
   *  agent-turn persistence (a real FK on caye_frontdesk_agent_turns). */
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

/**
 * Scans the turns a tool-loop invocation produced for a successful
 * `send_customer_reply` call. Real production behavior, not a replay
 * heuristic: pairs each `tool_use` block with its matching `tool_result`
 * by `tool_use_id` (the same pairing the Anthropic API itself requires),
 * then reads the SAME `stripForModel`-shaped payload the model saw.
 */
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

  try {
    // Owner policy beats model judgment, always (#88). Resolve standing
    // rules + the existing hold BEFORE the model gets a chance to run — an
    // owner_only match or a held conversation must never reach the tool
    // loop, let alone send_customer_reply.
    const authz = await authorizeAutonomousOutbound({
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      inboundBody: input.inboundBody,
    })
    if (!authz.allowed) {
      const holdReason =
        authz.reason === 'blocked_by_owner_policy'
          ? (authz.escalation?.internalContext ?? 'Owner-only standing rule matched — held for the owner.')
          : 'Conversation is already held for the owner — Caye will not reply autonomously until it is released.'
      await markHeld(supabase, input, holdReason)
      return { outcome: 'held', toolsUsed: [], usedOutputFallbackPath: false, holdReason }
    }

    const [{ history: historyForModel }, relationshipCtx, operational] = await Promise.all([
      // loadFrontDeskConversationContext's `history` field is ALREADY
      // relative-time-annotated + compacted (see context.ts's own doc
      // comment) — this is the form to feed the model directly, not a raw
      // form needing further processing.
      loadFrontDeskConversationContext(input.conversationId),
      loadRelationshipContext(input.workspaceId, input.contactId ?? null),
      loadOperationalContext(input.workspaceId, 'front-desk'),
    ])

    // The customer's current message is already the last row of the
    // reloaded history — claimInboundMessage persisted it BEFORE this
    // function was ever called. No manual turn construction needed.
    if (historyForModel.length === 0) {
      throw new Error('loadFrontDeskConversationContext returned no history — the triggering inbound row is missing')
    }

    const situation = {
      channel: 'front-desk' as const,
      workspaceId: input.workspaceId,
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
      // System invocation, not a human operator — same precedent as cron
      // paths (briefings, EOD summaries), which use 'founder' per Role's
      // own doc comment ("Cron-driven system invocations... use 'founder'
      // since they have no human caller and need access to every tool").
      // A real customer-facing email turn is exactly this shape: no human
      // operator identity to attach, needs the full front-desk tool set.
      callerRole: 'founder' as const,
      requestId: randomUUID(),
      conversationId: input.conversationId,
      triggeringMessageId: input.triggeringMessageId,
      evidenceCollected: [],
    }

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    const loopResult = await runToolLoop({
      client,
      model: 'claude-sonnet-4-6',
      maxTokens: 1536,
      systemPrompt,
      initialMessages: historyForModel,
      ctx,
      mode: 'front-desk',
      // No `tools` override — the real TOOL_REGISTRY filtered to
      // modes:['front-desk'] is exactly what should run in production.
    })

    const sendResult = findSuccessfulSend(loopResult.newTurns)
    const toolsUsed = collectToolsUsed(loopResult.newTurns)

    // Persistence is deliberately isolated from the outcome determination
    // below it. A real customer email may already have gone out (via
    // send_customer_reply -> dispatchOperatorReply, inside runToolLoop,
    // ABOVE this line) by the time persistence runs — a persistence
    // failure here (e.g. the caye_frontdesk_agent_turns migration not yet
    // applied) must NEVER be allowed to turn an already-successful send
    // into a reported error/hold. That would be actively misleading: the
    // customer got their reply, but the owner would see "Caye hit an
    // error" and the dashboard would show held/error instead of sent.
    // Continuity (what persistence buys) degrading is an acceptable,
    // visible-in-logs failure mode; double-reporting a real send as a
    // failure is not.
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

    // Held (evidence insufficient, or the model never produced a send) —
    // same owner-notification shape the legacy hold path already uses,
    // so Mrs. Max isn't left unaware a customer message went unanswered.
    const holdReason = 'Caye (converged) could not answer with enough confidence — held for review.'
    await markHeld(supabase, input, holdReason)
    return { outcome: 'held', toolsUsed, usedOutputFallbackPath: !!loopResult.usedOutputFallbackPath, holdReason }
  } catch (err) {
    // Part 22: a crash must fail closed, not fall through to the legacy
    // generator — that risks two independent customer responses. Treat
    // exactly like a hold, with the error visible to the owner.
    const message = err instanceof Error ? err.message : String(err)
    console.error('[frontdesk-entry] converged runtime threw:', message)
    const holdReason = `Caye (converged) hit an error and could not process this message: ${message}`
    try {
      await markHeld(supabase, input, holdReason)
    } catch (holdErr) {
      console.error('[frontdesk-entry] also failed to record the fallback hold:', holdErr)
    }
    return { outcome: 'error', toolsUsed: [], usedOutputFallbackPath: false, errorMessage: message, holdReason }
  }
}

async function markHeld(
  supabase: ReturnType<typeof createServiceClient>,
  input: ConvergedFrontDeskTurnInput,
  reason: string
): Promise<void> {
  await supabase
    .from('unified_conversations')
    .update({ human_agent_enabled: true, human_agent_reason: reason })
    .eq('id', input.conversationId)

  await supabase.from('unified_messages').insert({
    conversation_id: input.conversationId,
    channel_message_id: null,
    sender_type: 'business',
    content: reason,
    message_type: 'text',
    sent_at: new Date().toISOString(),
    status: 'sent',
    is_internal: true,
    metadata: { generated_by: 'caye', hold_reason: reason, runtime: 'converged_frontdesk' },
  })

  await enqueueHoldPing({
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    contactName: input.contactName,
    reason,
    inboundBody: input.inboundBody,
  }).catch((err) => console.error('[frontdesk-entry] enqueueHoldPing failed:', err))
}
