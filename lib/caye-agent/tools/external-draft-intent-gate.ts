import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { Tool } from './types'

const EXTERNAL_DRAFT_REQUEST =
  /(?:\b(?:put|save|file|create|make|leave|place|push)\b[\s\S]{0,80}\b(?:gmail|e-?mail|mail|inbox)\b[\s\S]{0,30}\bdrafts?\b|\b(?:gmail|e-?mail|mail|inbox)\b[\s\S]{0,30}\bdrafts?\b|\bdrafts?\s+folder\b)/i

const ATTACHMENT_HANDOFF =
  /\b(?:attach|add|include)\b[\s\S]{0,50}\b(?:photos?|images?|files?|documents?|attachments?)\b/i

const AFFIRMATIVE =
  /^(?:yes|yes please|yep|yeah|sure|go ahead|do it|please|ok|okay|correct|that works)(?:[.!\s]*)$/i

const EXTERNAL_DRAFT_OFFER =
  /(?:\b(?:put|save|file|create|push)\b[\s\S]{0,80}\b(?:gmail|e-?mail|mail|inbox|drafts? folder)\b|\bfile it to your drafts?\b|\bput it in your drafts?\b)/i

/**
 * Turn-scoped intent check for the one tool whose destination is easy to
 * confuse with the ordinary English verb "draft".
 *
 * A past request to use email drafts does NOT carry forward into later
 * revisions. The current operator turn must either request the external
 * artifact itself, or be a short affirmative response to Caye immediately
 * offering that exact destination. This deliberately makes destination
 * intent ephemeral while preserving a natural "put it in Drafts?" → "yes"
 * exchange.
 */
export function hasExplicitExternalDraftIntent(args: {
  operatorText: string
  previousCayeText?: string | null
}): boolean {
  const operatorText = args.operatorText.trim()
  const previousCayeText = args.previousCayeText?.trim() ?? ''

  if (!operatorText) return false
  if (EXTERNAL_DRAFT_REQUEST.test(operatorText)) return true

  // Attachment handoff is the other documented reason for the external
  // artifact: Caye cannot attach files to send_reply, so the operator needs
  // the message in their own mail client to add the files and send it.
  if (
    ATTACHMENT_HANDOFF.test(operatorText) &&
    /\b(?:draft|e-?mail|mail|send|myself|myself)\b/i.test(operatorText)
  ) {
    return true
  }

  return AFFIRMATIVE.test(operatorText) && EXTERNAL_DRAFT_OFFER.test(previousCayeText)
}

/**
 * Structural backstop around the already-high-risk draft_in_inbox tool.
 *
 * gateHighRisk protects execution, but by itself it still lets the model
 * STAGE an external inbox draft off a bare "draft please", which is enough
 * to derail the operator conversation and ask for the wrong confirmation.
 * This wrapper runs *outside* gateHighRisk and refuses even to stage the
 * action unless the latest real operator turn establishes external-draft
 * intent.
 *
 * The WhatsApp operator route persists the inbound row before cayeAgent runs.
 * Caye Direct uses the same caye_operator_messages history model. Heartbeat
 * rows are ignored because they intentionally have no claude_format.
 */
export function gateExternalDraftIntent<T>(tool: Tool<T>): Tool<T> {
  if (tool.name !== 'draft_in_inbox') return tool

  return {
    ...tool,
    async execute(input, ctx) {
      if (ctx.origin === 'scan') {
        return {
          ok: false,
          error: 'External email drafts can only be staged from an explicit operator request.',
        }
      }
      if (!ctx.operatorId) {
        return {
          ok: false,
          error: 'External email drafts require a verified operator conversation.',
        }
      }

      const supabase = createServiceClient()
      const { data: rows, error } = await supabase
        .from('caye_operator_messages')
        .select('direction, body, claude_format, created_at')
        .eq('workspace_id', ctx.workspaceId)
        .eq('operator_allowlist_id', ctx.operatorId)
        .order('created_at', { ascending: false })
        .limit(12)

      if (error || !rows) {
        return {
          ok: false,
          error: 'Could not verify that the operator explicitly requested an external email draft.',
        }
      }

      const currentInboundIndex = rows.findIndex(
        (row) => row.direction === 'inbound' && typeof row.body === 'string' && row.body.trim().length > 0
      )
      if (currentInboundIndex < 0) {
        return {
          ok: false,
          error: 'No current operator request was available to authorize an external email draft.',
        }
      }

      const current = rows[currentInboundIndex]
      const previousCaye = rows
        .slice(currentInboundIndex + 1)
        .find(
          (row) =>
            row.direction === 'outbound' &&
            row.claude_format != null &&
            typeof row.body === 'string' &&
            row.body.trim().length > 0
        )

      if (
        !hasExplicitExternalDraftIntent({
          operatorText: current.body as string,
          previousCayeText: (previousCaye?.body as string | undefined) ?? null,
        })
      ) {
        return {
          ok: false,
          error:
            'The operator asked to compose or revise a draft in the current conversation, not to create an external email draft. Show the full draft inline instead. Only use this tool when the current turn explicitly asks for Gmail/email Drafts, or explicitly accepts Caye\'s immediately preceding offer to put it there.',
        }
      }

      return tool.execute(input, ctx)
    },
  }
}
