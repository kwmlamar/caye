import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { setAttentionStatus } from '@/lib/owner-attention'

interface OpenAttentionRow {
  subject_type: string
  subject_id: string
  title: string
  last_notification_queue_id: string | null
}

export interface AttentionSubjectRef {
  subjectType: string
  subjectId: string
}

/**
 * Which open attention item(s), if any, does this inbound operator message
 * address — so acknowledgement is scoped to what the reply actually answers,
 * never to every open item in the workspace.
 *
 * "Karin Roberts still needs her deposit invoice." followed by "What
 * bookings do we have Saturday?" must not clear the Karin item — a generic
 * reply is not evidence about an unrelated reminder. Two deterministic
 * signals, checked in order, and NOTHING beyond them:
 *
 *   1. WhatsApp reply-to (message.context.id). The operator long-pressed a
 *      specific prior message and replied to it — unambiguous. Resolve that
 *      message's wa_message_id to the caye_outbound_queue row it was sent
 *      as, then to whichever attention item that row notified about
 *      (last_notification_queue_id).
 *   2. A distinguishing name token — the part of an open item's title before
 *      " — " (every producer titles items "{who/what} — {summary}") —
 *      appears in the reply text. Cheap substring check, not a classifier.
 *      Matching zero or more than one open item is ambiguous and resolves
 *      nothing; a real name match is specific enough on its own that this
 *      one case is worth the narrow heuristic.
 *
 * Anything else — a bare "ok", "thanks", "yes", an unrelated question —
 * resolves to nothing. When uncertain, stay silent: a wrongly-cleared urgent
 * item is worse than one redundant reminder later.
 */
export async function resolveAcknowledgedAttentionItems(args: {
  workspaceId: string
  replyToMessageId?: string | null
  bodyText: string
}): Promise<AttentionSubjectRef[]> {
  const supabase = createServiceClient()

  const { data: open } = await supabase
    .from('caye_owner_attention')
    .select('subject_type, subject_id, title, last_notification_queue_id')
    .eq('workspace_id', args.workspaceId)
    .in('status', ['open', 'acknowledged'])
  const openItems = (open ?? []) as OpenAttentionRow[]
  if (openItems.length === 0) return []

  if (args.replyToMessageId) {
    const { data: queueRow } = await supabase
      .from('caye_outbound_queue')
      .select('id')
      .eq('wa_message_id', args.replyToMessageId)
      .maybeSingle()
    if (queueRow) {
      const matched = openItems.find((i) => i.last_notification_queue_id === queueRow.id)
      if (matched) return [{ subjectType: matched.subject_type, subjectId: matched.subject_id }]
    }
    // A reply-to that doesn't resolve to a tracked notification isn't
    // evidence either way — fall through to the text-match signal instead
    // of stopping here.
  }

  const text = args.bodyText.toLowerCase().trim()
  if (!text) return []

  // First token of the name half of the title ("Karin Roberts — deposit
  // invoice" → "Karin") — real replies use a first name ("send Karin her
  // invoice"), not the full title string. Whole-word match, not a bare
  // substring, so "Karin" doesn't false-match inside an unrelated longer
  // word. Still narrow: one token, no stemming, no fuzzy matching.
  const nameMatches = openItems.filter((item) => {
    const fullName = item.title.split(' — ')[0]?.trim()
    const firstToken = fullName?.split(/\s+/)[0]
    if (!firstToken || firstToken.length < 3) return false
    const wordBoundary = new RegExp(`\\b${firstToken.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
    return wordBoundary.test(text)
  })
  if (nameMatches.length === 1) {
    return [{ subjectType: nameMatches[0].subject_type, subjectId: nameMatches[0].subject_id }]
  }

  return []
}

/** Marks the resolved item(s) acknowledged — "operator has responded, stop
 *  reminding until something changes." A material fingerprint change still
 *  reopens it (see decideOperatorNotification); this only silences repeats
 *  of the same unchanged ask. Best-effort, never throws. */
export async function acknowledgeAttentionItems(
  workspaceId: string,
  items: AttentionSubjectRef[]
): Promise<void> {
  for (const item of items) {
    try {
      await setAttentionStatus({
        workspaceId,
        subjectType: item.subjectType,
        subjectId: item.subjectId,
        status: 'acknowledged',
      })
    } catch (err) {
      console.error('[attention-acknowledgement] setStatus failed:', err)
    }
  }
}
