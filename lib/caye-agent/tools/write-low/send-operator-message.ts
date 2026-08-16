import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { isWhatsAppWindowOpen } from '@/lib/whatsapp/window'
import { sendFreeFormWhatsApp, sendTemplateWhatsApp } from '@/lib/whatsapp/outbound'
import type { Tool, ToolContext } from '../types'
import { succeeded, failedRetryable, failedPermanent, notFound, needsHuman } from '../result'

interface SendOperatorMessageInput {
  operator_allowlist_id: number
  message: string
}

interface TargetOperator {
  id: number
  name: string | null
  role: string
  phone: string
  verified_at: string | null
}

// Meta's approved fallback template (caye_urgent_hold) has one free-text
// placeholder, and long params read poorly on a lock screen — but the real
// reason this is a hard cap, not a style preference, is requirement #3
// (2026-08-16 hardening): a template send either carries the WHOLE message
// or it doesn't go out at all. There is no approved template built to carry
// arbitrary-length operator content, and inventing one isn't something this
// tool can do (Meta template review, not a code change) — so when the
// window is closed and the message doesn't fit, the honest answer is
// "can't deliver this right now," not a quietly shortened version reported
// as fully sent.
const TEMPLATE_SAFE_MAX_LEN = 180

function normalizeForTemplate(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** True only when the message fits the template's placeholder with zero loss. */
function fitsTemplateWithoutLoss(message: string, maxLen = TEMPLATE_SAFE_MAX_LEN): boolean {
  return normalizeForTemplate(message).length <= maxLen
}

/**
 * Send a real WhatsApp message to another authorized operator on this
 * workspace — Caye reaching out to Mrs. Max/Max/staff on her own
 * initiative, not replying to whoever is currently talking to her.
 *
 * WHY THIS EXISTS (2026-08-16, incident follow-up)
 * A founder told Caye Direct to "bring these opportunities to Mrs. Max
 * yourself... over WhatsApp." No tool existed that could reach an operator
 * other than the caller — send_reply targets a customer conversation,
 * schedule_reminder only writes back to whoever asked — so the model
 * fabricated "here's what I sent her" with zero backing tool call
 * (lib/caye-agent/action-claim-guard.ts is the backstop for that failure
 * mode generally; this tool closes the actual capability gap it exposed).
 *
 * DISPATCH IS SYNCHRONOUS, DELIBERATELY NOT QUEUED. Every other
 * Caye-initiated operator ping (escalation, reminder, digest) goes through
 * caye_outbound_queue + the ~30s cron (lib/whatsapp/triggers.ts,
 * app/api/caye/outbound-worker/route.ts) because nothing is watching for
 * an immediate answer. Here the founder is mid-conversation and the whole
 * point is that Caye can only say "sent" once it verifiably has been —
 * a queued-but-undispatched row is not a completed action (see
 * action-claim-guard.ts's groundedBy check, which treats a pending/staged
 * result the same as no send at all). So this calls the same low-level
 * Meta dispatch primitives the worker uses (isWhatsAppWindowOpen,
 * sendFreeFormWhatsApp/sendTemplateWhatsApp from lib/whatsapp/outbound.ts)
 * directly, inline, and only returns ok:true once Meta has actually
 * accepted the message.
 *
 * IDEMPOTENCY: claims a caye_outbound_queue row keyed on
 * ctx.operationKey (deterministic per turn+tool+args — see
 * orchestrator.ts's operationKey doc comment) before dispatching, via the
 * table's existing idempotency_key UNIQUE constraint — the same
 * claim-before-execute pattern confirm-pending-action.ts uses for exactly
 * this concurrency-safety reason. scheduled_for is set an hour out so the
 * cron's `status='pending' AND scheduled_for<=now` poll can never race this
 * synchronous dispatch and double-send; the row is always resolved to a
 * terminal state (or deleted, on a transient failure, so the orchestrator's
 * own retry can cleanly re-attempt) before execute() returns.
 *
 * On success, persists directly into caye_operator_messages with the
 * TARGET operator's operator_allowlist_id (not the caller's) — same insert
 * shape app/api/caye/outbound-worker/route.ts's logOperatorPing already
 * uses for escalation/reminder pings. That is also the exact table
 * loadOperatorContext (context.ts) replays for that operator's next turn
 * and app/api/founder/caye-direct/route.ts's GET reads for Live — reusing
 * it is what makes both Live visibility and reply continuity automatic,
 * with no UI or context-loading change required.
 *
 * 2026-08-16 HARDENING (post-launch review, before first production use):
 *   - roles narrowed to owner/founder — staff can no longer INITIATE a
 *     proactive send (still a valid TARGET). Target-resolution rules
 *     (workspace, verification, driver exclusion, self-send) unchanged.
 *   - crash/orphan recovery: if the process dies between claiming the
 *     queue row and resolving it, the row is never silently lost nor
 *     blindly retried — app/api/caye/outbound-worker/route.ts's
 *     checkOrphanedOperatorMessagesAndAlert sweeps and dead-letters it,
 *     alerting the founder rather than risking a duplicate send. See that
 *     function's doc comment for the reasoning.
 *   - closed-window long messages are never silently shortened — see
 *     fitsTemplateWithoutLoss below.
 */
export const sendOperatorMessage: Tool<SendOperatorMessageInput> = {
  name: 'send_operator_message',
  description: `Send a real WhatsApp message to another authorized operator on this workspace — the owner or founder, NOT the person you're currently talking to. Use when you need someone else's input to continue real business work (e.g. the current caller asked you to loop in the owner) — never to reach a customer.

operator_allowlist_id is REQUIRED and must come from get_team_members' \`id\` field. You can never supply a raw phone number — there is no way to message anyone not already on the team list.

This sends immediately — there is no draft/confirm step, the same way schedule_reminder executes right away, because the only person it can ever reach is another operator, never a guest. Only report the message as sent once this tool returns ok:true; if it returns an error, say so plainly and do not claim it went out. If the target's WhatsApp window is closed and the message is too long for the fallback template, this will fail rather than send a cut-down version — relay that honestly, don't shorten and retry to force it through.`,
  risk: 'low',
  // Restricted to owner/founder (2026-08-16 hardening) — staff removed for
  // now. This gates who may INSTRUCT Caye to initiate a proactive operator
  // send; it has no bearing on the target-resolution rules below (those
  // stay workspace/verification-scoped regardless of caller role).
  roles: ['owner', 'founder'],
  modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      operator_allowlist_id: {
        type: 'number',
        description: "The target operator's id, from get_team_members.",
      },
      message: {
        type: 'string',
        description: 'The exact text to send. Delivered as-is over WhatsApp.',
      },
    },
    required: ['operator_allowlist_id', 'message'],
  },

  async execute(args, ctx: ToolContext) {
    const message = args.message?.trim()
    if (!message) return failedPermanent('EMPTY_MESSAGE', 'I need actual message text to send.')
    if (!Number.isFinite(args.operator_allowlist_id)) {
      return failedPermanent('INVALID_OPERATOR_ID', 'operator_allowlist_id must be a number from get_team_members.')
    }

    const supabase = createServiceClient()

    // Canonical, workspace-scoped resolution — the model supplies an id,
    // never a phone number, and this query can only ever match a row
    // belonging to ctx.workspaceId. A valid id from a DIFFERENT workspace
    // matches nothing here, which is what makes cross-workspace messaging
    // structurally impossible rather than merely discouraged.
    const { data: target, error: lookupError } = await supabase
      .from('operator_allowlist')
      .select('id, name, role, phone, verified_at')
      .eq('id', args.operator_allowlist_id)
      .eq('workspace_id', ctx.workspaceId)
      .maybeSingle<TargetOperator>()

    if (lookupError) return failedRetryable('OPERATOR_LOOKUP_FAILED', lookupError.message)
    if (!target) {
      return notFound('No operator with that id on this workspace — check get_team_members and try again.')
    }
    if (target.role === 'driver') {
      return failedPermanent('WRONG_TOOL_FOR_DRIVER', 'Use notify_driver for drivers, not send_operator_message.')
    }
    if (target.id === ctx.operatorId) {
      return failedPermanent('CANNOT_MESSAGE_SELF', "That's you — no need to message yourself through this tool.")
    }
    if (!target.verified_at) {
      return needsHuman(
        'OPERATOR_UNVERIFIED',
        `${target.name ?? 'That operator'} hasn't verified their WhatsApp yet — I can't message them until they do.`
      )
    }

    const { data: config, error: configError } = await supabase
      .from('workspace_ai_config')
      .select('whatsapp_outbound_enabled, notifications_paused, whatsapp_blocked')
      .eq('workspace_id', ctx.workspaceId)
      .maybeSingle()
    if (configError) return failedRetryable('CONFIG_LOOKUP_FAILED', configError.message)
    if (!config?.whatsapp_outbound_enabled) {
      return failedPermanent('NO_CHANNEL', "Operator WhatsApp isn't set up on this workspace — there's no channel to send this on.")
    }
    if (config.notifications_paused) {
      return failedPermanent('NOTIFICATIONS_PAUSED', "Operator notifications are paused on this workspace — nothing can go out right now.")
    }
    if (config.whatsapp_blocked) {
      return needsHuman('WHATSAPP_BLOCKED', "This workspace's WhatsApp number is blocked — I can't send anything until that's resolved.")
    }

    // Claim-before-send: one row per (turn, tool, args) via the table's
    // existing idempotency_key UNIQUE constraint. scheduled_for is pushed
    // an hour out purely to keep this row outside the cron's
    // `scheduled_for <= now` poll window while the dispatch below runs —
    // it is always resolved (or deleted) before this call returns, so the
    // cron never actually sees it in the normal case.
    const idempotencyKey = ctx.operationKey ?? `send_operator_message:${ctx.requestId}:${target.id}:adhoc`
    const claimedFor = new Date(Date.now() + 60 * 60 * 1000).toISOString()

    const { data: claimed, error: claimError } = await supabase
      .from('caye_outbound_queue')
      .insert({
        workspace_id: ctx.workspaceId,
        kind: 'operator_message',
        // to_phone/operator_name carried purely for the orphan sweep's
        // founder alert (app/api/caye/outbound-worker/route.ts) — this row
        // is never dispatched by the worker itself, only ever swept and
        // dead-lettered if it's still here long after it should have
        // resolved. See that sweep's doc comment for why it never retries.
        payload: { operator_allowlist_id: target.id, operator_name: target.name, to_phone: target.phone, body: message },
        scheduled_for: claimedFor,
        status: 'pending',
        idempotency_key: idempotencyKey,
      })
      .select('id')
      .single()

    if (claimError) {
      if (claimError.code !== '23505') return failedRetryable('CLAIM_FAILED', claimError.message)

      // Already claimed — this exact (turn, tool, args) was seen before.
      // Report the EXISTING outcome rather than dispatching again.
      const { data: existing } = await supabase
        .from('caye_outbound_queue')
        .select('status, wa_message_id, last_error')
        .eq('idempotency_key', idempotencyKey)
        .maybeSingle()

      if (existing?.status === 'sent') {
        return succeeded({
          operator_allowlist_id: target.id,
          operator_name: target.name,
          channel: 'whatsapp',
          message_id: existing.wa_message_id,
          sent: true,
          idempotent_replay: true,
        })
      }
      if (existing?.status === 'failed' || existing?.status === 'dead_letter') {
        return failedPermanent('ALREADY_FAILED', existing.last_error ?? 'That message already failed to send once — not retrying automatically.')
      }
      // status === 'pending': a concurrent call is mid-dispatch. Retryable
      // — the orchestrator's own budget gives this a second, later attempt.
      return failedRetryable('IN_FLIGHT', 'Another send with the same content is already in progress.')
    }

    // We hold the claim. Dispatch for real.
    try {
      const windowOpen = await isWhatsAppWindowOpen(ctx.workspaceId, target.phone)

      // Closed window + a message the approved template can't carry whole:
      // refuse rather than silently ship a cut-down version as "sent" (the
      // #3 hardening requirement). Release the claim — nothing was ever
      // attempted, so this isn't a duplicate-send risk, and a shortened
      // retry (or the operator messaging Caye to reopen the window) can
      // claim it again under a fresh idempotency key.
      if (!windowOpen && !fitsTemplateWithoutLoss(message)) {
        await supabase.from('caye_outbound_queue').delete().eq('id', claimed.id)
        const len = normalizeForTemplate(message).length
        return needsHuman(
          'WINDOW_CLOSED_MESSAGE_TOO_LONG',
          `${target.name ?? 'That operator'}'s WhatsApp window is closed, and this message (${len} chars) is too long for the only approved fallback template (~${TEMPLATE_SAFE_MAX_LEN} chars) — sending it would cut real content, so I didn't send anything. It'll go through in full once they message me again to reopen the window, or you can shorten it under ${TEMPLATE_SAFE_MAX_LEN} characters.`
        )
      }

      const result = windowOpen
        ? await sendFreeFormWhatsApp(target.phone, message, idempotencyKey)
        : await sendTemplateWhatsApp(target.phone, 'caye_urgent_hold', ['Caye', normalizeForTemplate(message)], idempotencyKey)

      if (result.status === 'sent') {
        await supabase
          .from('caye_outbound_queue')
          .update({ status: 'sent', sent_at: new Date().toISOString(), wa_message_id: result.messageId })
          .eq('id', claimed.id)

        await supabase.from('caye_operator_messages').insert({
          workspace_id: ctx.workspaceId,
          direction: 'outbound',
          wa_message_id: result.messageId,
          wa_delivery_status: 'sent',
          wa_delivery_error: null,
          body: message,
          intent: null,
          operator_allowlist_id: target.id,
          operator_name: target.name,
          operator_role: target.role,
          origin: 'whatsapp',
        })

        return succeeded({
          operator_allowlist_id: target.id,
          operator_name: target.name,
          channel: 'whatsapp',
          message_id: result.messageId,
          sent: true,
          delivered_via: windowOpen ? 'free_form' : 'template',
        })
      }

      // Real dispatch failure. Nothing was sent.
      if (result.transient) {
        // Nothing was delivered — release the claim so a retry (the
        // orchestrator's own budget, or the model calling again) can
        // actually attempt the send instead of replaying a cached failure.
        await supabase.from('caye_outbound_queue').delete().eq('id', claimed.id)
        return failedRetryable('SEND_FAILED_TRANSIENT', result.error)
      }

      await supabase
        .from('caye_outbound_queue')
        .update({ status: result.blocked ? 'dead_letter' : 'failed', last_error: result.error })
        .eq('id', claimed.id)

      return result.blocked
        ? needsHuman('SEND_BLOCKED', `${target.name ?? 'That operator'} appears to have blocked this number — I can't reach them over WhatsApp.`)
        : failedPermanent('SEND_FAILED', result.error)
    } catch (err) {
      // Unexpected throw mid-dispatch — never held to have delivered
      // anything. Same release-the-claim treatment as a transient failure.
      await supabase.from('caye_outbound_queue').delete().eq('id', claimed.id)
      const msg = err instanceof Error ? err.message : String(err)
      return failedRetryable('SEND_THREW', msg)
    }
  },
}
