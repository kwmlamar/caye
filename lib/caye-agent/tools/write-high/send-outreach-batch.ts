import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { dispatchOperatorReply } from '@/lib/whatsapp/channel-dispatch'
import type { Tool } from '../types'
import { assertConversationOwnedByWorkspace } from '../write-low/_guards'

interface SendOutreachBatchItem {
  conversation_id: string
  email: string
  subject: string
}

interface SendOutreachBatchInput {
  items: SendOutreachBatchItem[]
}

/**
 * Batch-approved first-touch cold-outreach sends — step 3 of the 2026-07-21
 * staged-autonomy roadmap (decisions-log): the operator approves a list
 * once, Caye sends all of them, instead of per-message review. Step 4
 * (fully autonomous first-touch with no review at all) stays permanently
 * off the roadmap — this tool never runs without the code-enforced
 * gateHighRisk confirmation round-trip (see registry.ts), same mechanism
 * as send_reply/cancel_booking/etc.
 *
 * Deliberately re-reads metadata.proposed_reply from the conversation row
 * rather than trusting any body text the model might pass — the
 * email/subject fields in args exist only so the staged confirmation
 * summary is human-readable. This guarantees the draft the operator
 * approved (via get_pending_quotes) is byte-for-byte what ships, closing
 * the same "shown vs. sent" drift gap gateHighRisk's own doc comment
 * describes for single sends.
 */
export const sendOutreachBatch: Tool<SendOutreachBatchInput> = {
  name: 'send_outreach_batch',
  description:
    "Send a batch of held first-touch cold-outreach emails the operator has already reviewed via " +
    "get_pending_quotes (items with hold_kind 'outreach_first_touch'). HIGH-RISK — ships real, " +
    "non-opted-in cold email; only ever call with conversation_ids that came from get_pending_quotes. " +
    "CONFIRMATION IS ENFORCED IN CODE, not just by this text — the first call with a given item list " +
    "only stages it and returns un-executed, nothing is sent yet. Relay the staged summary (count + " +
    "recipient/subject list) to the operator and ask them to confirm. Once they reply affirmatively in " +
    "a NEW message, call this again with the EXACT SAME items to actually send. The email/subject " +
    "fields are for the confirmation summary only — the tool always sends the exact draft text stored " +
    "on the thread at create_outreach_leads time, never text regenerated in this turn. This tool " +
    "refuses any conversation_id that isn't a held 'outreach_first_touch' thread.",
  risk: 'high',
  roles: ['owner', 'founder'],
  modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description: 'The held outreach threads to send, as returned by get_pending_quotes.',
        items: {
          type: 'object',
          properties: {
            conversation_id: {
              type: 'string',
              description: 'conversation_id from get_pending_quotes.',
            },
            email: {
              type: 'string',
              description: 'Recipient email, for the confirmation summary only.',
            },
            subject: {
              type: 'string',
              description: 'Draft subject, for the confirmation summary only.',
            },
          },
          required: ['conversation_id', 'email', 'subject'],
        },
      },
    },
    required: ['items'],
  },

  async execute(args, ctx) {
    if (!args.items?.length) return { ok: false, error: 'No items provided' }

    const supabase = createServiceClient()
    const sent: string[] = []
    const failed: { email: string; error: string }[] = []

    for (const item of args.items) {
      const owned = await assertConversationOwnedByWorkspace(
        supabase,
        item.conversation_id,
        ctx.workspaceId
      )
      if (!owned.ok) {
        failed.push({ email: item.email, error: owned.error ?? 'not owned by this workspace' })
        continue
      }

      const { data: conv, error: convErr } = await supabase
        .from('unified_conversations')
        .select('metadata')
        .eq('id', item.conversation_id)
        .single()
      if (convErr || !conv) {
        failed.push({ email: item.email, error: 'thread not found' })
        continue
      }

      const meta = (conv.metadata ?? {}) as Record<string, unknown>
      if (meta.hold_kind !== 'outreach_first_touch') {
        failed.push({ email: item.email, error: 'not a held first-touch outreach thread' })
        continue
      }
      const draft = typeof meta.proposed_reply === 'string' ? meta.proposed_reply : ''
      if (!draft.trim()) {
        failed.push({ email: item.email, error: 'no draft stored on this thread' })
        continue
      }

      try {
        await dispatchOperatorReply(item.conversation_id, draft, 'caye-dashboard')
        sent.push(item.email)
      } catch (err) {
        failed.push({
          email: item.email,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    return {
      ok: true,
      data: { sent_count: sent.length, sent, failed_count: failed.length, failed },
    }
  },
}
