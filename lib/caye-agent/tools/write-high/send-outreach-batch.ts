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

/** hold_kind values eligible for batch send — first-touch opens (roadmap
 *  step 3) and their one allowed follow-up nudge (roadmap step 2, which
 *  decisions-log called "graduated to autosend" but was never actually
 *  wired to send — outreach-nudge-scan only ever holds it, same as
 *  first-touch). Both are a single Caye-drafted message the operator
 *  reviews once before it ships; neither is the permanently-gated step-4
 *  "zero review" case. */
const BATCHABLE_HOLD_KINDS = new Set(['outreach_first_touch', 'outreach_followup'])

/**
 * Batch-approved cold-outreach sends — first-touch opens (roadmap step 3)
 * and their one allowed follow-up nudge (roadmap step 2) — from the
 * 2026-07-21 staged-autonomy roadmap (decisions-log): the operator approves
 * a list once, Caye sends all of them, instead of per-message review. Step
 * 4 (fully autonomous first-touch with no review at all) stays permanently
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
    "Send a batch of held cold-outreach emails the operator has already reviewed via get_pending_quotes " +
    "— first-touch opens (hold_kind 'outreach_first_touch') and/or their one allowed follow-up nudge " +
    "(hold_kind 'outreach_followup'). HIGH-RISK — ships real, non-opted-in cold email; only ever call " +
    "with conversation_ids that came from get_pending_quotes. CONFIRMATION IS ENFORCED IN CODE, not " +
    "just by this text — the first call with a given item list only stages it and returns un-executed, " +
    "nothing is sent yet. Relay the staged summary (count + recipient/subject list) to the operator and " +
    "ask them to confirm. Once they reply affirmatively in a NEW message, call this again with the " +
    "EXACT SAME items to actually send. The email/subject fields are for the confirmation summary " +
    "only — the tool always sends the exact draft text stored on the thread, never text regenerated in " +
    "this turn. This tool refuses any conversation_id that isn't a held outreach thread of one of those " +
    "two kinds — it will never send anything with zero prior human review.",
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
      if (typeof meta.hold_kind !== 'string' || !BATCHABLE_HOLD_KINDS.has(meta.hold_kind)) {
        failed.push({ email: item.email, error: 'not a held outreach thread eligible for batch send' })
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
