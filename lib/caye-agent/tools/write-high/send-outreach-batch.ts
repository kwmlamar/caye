import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { dispatchOperatorReply } from '@/lib/whatsapp/channel-dispatch'
import type { Tool } from '../types'
import { assertConversationOwnedByWorkspace } from '../write-low/_guards'
import { findOutreachDraftIssues, describeDraftIssues } from '@/lib/outreach-draft-guard'
import { QUEUE_HOLD_KINDS } from '@/lib/hold-kinds'

interface SendOutreachBatchItem {
  conversation_id: string
  email: string
  subject: string
}

interface SendOutreachBatchInput {
  items: SendOutreachBatchItem[]
}

/** hold_kind values eligible for batch send — first-touch opens and follow-up
 *  nudges. As of decisions-log 2026-08-12, most first-touch/follow-up
 *  drafts never reach this tool at all: app/api/caye/outreach-autosend-scan
 *  sends them directly with no review, unless the workspace is paused
 *  (outreach_autosend_paused) or a draft fails lib/outreach-draft-guard's
 *  content check — those two cases still land here as held items, so this
 *  tool remains the manual fallback/escape hatch, not the primary path it
 *  was through 2026-08-01.
 *
 *  Shared with the read layer (lib/hold-kinds.ts), which uses the same set
 *  to keep these out of the "needs your call" queue. The two MUST agree: a
 *  kind hidden from the operator's attention list but not batch-sendable
 *  would be invisible and unsendable, and the reverse would let a thread be
 *  batch-shipped that the operator was never shown. */
const BATCHABLE_HOLD_KINDS = QUEUE_HOLD_KINDS

/**
 * Batch-approved cold-outreach sends — first-touch opens and follow-up
 * nudges — originally built 2026-08-01 as step 3 of the 2026-07-21
 * staged-autonomy roadmap. As of decisions-log 2026-08-12, that roadmap's
 * step 4 ("fully autonomous first-touch, zero review, permanently off")
 * was explicitly reversed — app/api/caye/outreach-autosend-scan now sends
 * first-touch and follow-up drafts directly. This tool still exists and
 * still runs through the code-enforced gateHighRisk confirmation
 * round-trip (see registry.ts) — it's now the fallback for whatever the
 * autosend-scan cron couldn't send itself (paused workspace, daily cap
 * reached, or a draft that failed the content guard), not the everyday path.
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
    "nothing is sent yet — never tell the operator it went out. Relay the staged summary (count + " +
    "recipient/subject list) to the operator and ask them to confirm. Once they reply affirmatively in " +
    "a NEW message, call confirm_pending_action with the pending_action_id from the staged result — do " +
    "NOT call this tool again to confirm, since that only matches if the item list is byte-identical " +
    "and any drift silently stages a second batch. The email/subject fields are for the confirmation summary " +
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

      // Content gate. The generator is an LLM and demonstrably ignores its
      // own prompt rules at volume (2026-08-01: 7/31 shipped banned hedge
      // phrases, 1 shipped a literal "[First Name]"). Cold email can't be
      // recalled, so a suspect draft is held back for a rewrite rather
      // than sent on the assumption it's probably fine.
      const issues = findOutreachDraftIssues(draft)
      if (issues.length > 0) {
        failed.push({ email: item.email, error: describeDraftIssues(issues) })
        continue
      }

      // Never ship a held outreach draft to someone who has already written
      // back. Both batchable kinds are pre-reply by definition — a first
      // touch goes to a silent prospect, and a follow-up nudge only exists
      // BECAUSE they stayed silent — so any inbound customer message means
      // this draft was overtaken by events. Cheap, irreversible-path guard
      // that holds even if some future hold path forgets to clear the stale
      // metadata (see clearStaleOutreachAutofill and its call sites).
      const { count: inboundCount, error: inboundErr } = await supabase
        .from('unified_messages')
        .select('id', { count: 'exact', head: true })
        .eq('conversation_id', item.conversation_id)
        .eq('sender_type', 'customer')
      if (inboundErr) {
        failed.push({ email: item.email, error: `could not verify reply state: ${inboundErr.message}` })
        continue
      }
      if ((inboundCount ?? 0) > 0) {
        failed.push({
          email: item.email,
          error: 'prospect has already replied on this thread — draft is stale, reply to them directly instead',
        })
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
