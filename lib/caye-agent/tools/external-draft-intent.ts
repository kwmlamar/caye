import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { ToolContext, ToolResult } from './types'

const EXPLICIT_EXTERNAL_DRAFT =
  /(?:\b(?:put|save|file|create|make|leave|place|push)\b[\s\S]{0,80}\b(?:gmail|e-?mail|mail|inbox)\b[\s\S]{0,35}\bdrafts?\b|\b(?:gmail|e-?mail|mail|inbox)\b[\s\S]{0,35}\bdrafts?\b|\bdrafts?\s+folder\b)/i

const ATTACHMENT_HANDOFF =
  /\b(?:attach|add|include)\b[\s\S]{0,50}\b(?:photos?|images?|files?|documents?|attachments?)\b/i

const AFFIRMATIVE =
  /^(?:yes|yes please|yep|yeah|sure|go ahead|do it|please|ok|okay|correct|that works)(?:[.!\s]*)$/i

const EXPLICIT_EXTERNAL_DRAFT_OFFER =
  /(?:\b(?:put|save|file|create|push)\b[\s\S]{0,80}\b(?:gmail|e-?mail|mail|inbox|drafts? folder)\b|\b(?:put|file|save) it (?:to|in) your drafts?\b)/i

/**
 * External-draft destination is turn-scoped, never sticky.
 *
 * A previous Gmail/Zoho draft does not authorize later "draft please",
 * "change the price", or other revisions to keep living in email. The
 * current operator turn must explicitly ask for the external artifact, or
 * immediately affirm Caye's explicit offer to put it there.
 */
export function hasExplicitExternalDraftIntent(args: {
  operatorText: string
  previousCayeText?: string | null
}): boolean {
  const operatorText = args.operatorText.trim()
  const previousCayeText = args.previousCayeText?.trim() ?? ''
  if (!operatorText) return false

  if (EXPLICIT_EXTERNAL_DRAFT.test(operatorText)) return true

  if (
    ATTACHMENT_HANDOFF.test(operatorText) &&
    /\b(?:draft|e-?mail|mail|send|myself)\b/i.test(operatorText)
  ) {
    return true
  }

  return AFFIRMATIVE.test(operatorText) && EXPLICIT_EXTERNAL_DRAFT_OFFER.test(previousCayeText)
}

/**
 * Verify the latest real operator turn before draft_in_inbox can even enter
 * the normal high-risk staging flow. High-risk gating protects execution;
 * this protects intent, so the wrong external action cannot be staged from
 * the bare word "draft" in the first place.
 */
export async function verifyExternalDraftIntent(
  ctx: ToolContext
): Promise<ToolResult | null> {
  if (ctx.origin === 'scan') {
    return {
      ok: false,
      error: 'External email drafts require an explicit operator request in a live conversation.',
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
      error: 'Could not verify an explicit request for an external email draft.',
    }
  }

  const inboundIndex = rows.findIndex(
    (row) =>
      row.direction === 'inbound' &&
      typeof row.body === 'string' &&
      row.body.trim().length > 0
  )
  if (inboundIndex < 0) {
    return {
      ok: false,
      error: 'No current operator request was available to authorize an external email draft.',
    }
  }

  const current = rows[inboundIndex]
  const previousCaye = rows
    .slice(inboundIndex + 1)
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
        'This turn does not explicitly request an external Gmail/email Draft. Compose or revise the message in the current operator conversation instead. A previous external draft does not carry forward to later revisions.',
    }
  }

  return null
}
