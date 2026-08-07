import type Anthropic from '@anthropic-ai/sdk'

/**
 * The "this round was quiet" protocol between the opportunity-scan cron
 * and the model.
 *
 * The cron used to infer a quiet round from an empty agentResult.replyText,
 * which never happens — Caye always ends her turn with prose. So a scan
 * that found nothing still wrote "Nothing new this scan…", still counted as
 * a real finding, and still fired a founder alert plus a come-look template
 * ping at the owner. Three times a day, forever (confirmed live 2026-08-06).
 *
 * A token the model has to actually emit is checkable; the absence of one
 * is not. If the model forgets the token the scan is simply delivered as
 * before — the failure mode is the old behaviour, not a swallowed finding.
 */
export const QUIET_SENTINEL = 'NOTHING_TO_REPORT'

/**
 * Prefix match, not equality — the prompt asks for the token followed by a
 * short sentence so the row that lands in caye_operator_messages still
 * reads like English once stripQuietSentinel has run.
 */
export function isQuietScan(replyText: string): boolean {
  return replyText.trimStart().startsWith(QUIET_SENTINEL)
}

/** Drops the token and any separator punctuation the model put after it. */
export function stripQuietSentinel(text: string): string {
  const rest = text.trimStart().slice(QUIET_SENTINEL.length).replace(/^[\s—:.-]+/, '')
  return rest || 'Nothing needed attention this scan.'
}

/**
 * caye_operator_messages is both the audit trail and what Caye Direct
 * renders, so the sentinel has to come off before it's persisted —
 * "NOTHING_TO_REPORT" is a protocol detail between the cron and the model,
 * not something an operator should ever read in their own thread.
 *
 * Only the final assistant turn is rewritten: that's the one carrying the
 * reply text the sentinel was checked against.
 */
export function stripQuietSentinelFromTurns(
  turns: Anthropic.MessageParam[]
): Anthropic.MessageParam[] {
  const lastAssistant = turns.map((t) => t.role).lastIndexOf('assistant')
  if (lastAssistant < 0) return turns
  return turns.map((turn, i) => {
    if (i !== lastAssistant) return turn
    if (typeof turn.content === 'string') {
      return isQuietScan(turn.content) ? { ...turn, content: stripQuietSentinel(turn.content) } : turn
    }
    return {
      ...turn,
      content: turn.content.map((block) =>
        block.type === 'text' && isQuietScan(block.text)
          ? { ...block, text: stripQuietSentinel(block.text) }
          : block
      ),
    }
  })
}
