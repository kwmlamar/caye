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
 * Line-start match, not string-start — the prompt asks for the token
 * followed by a short sentence so the row that lands in
 * caye_operator_messages still reads like English once stripQuietSentinel
 * has run.
 *
 * Why line-start and not just string-start (2026-08-08, Bimini): the model
 * wrote a summary paragraph and then opened the SECOND paragraph with the
 * token. A string-start check missed it, so the round was delivered as a
 * real finding — pinging the owner about a scan that had explicitly
 * declared itself quiet — AND the raw token rendered in her thread because
 * nothing stripped it. The module's original comment anticipated the model
 * forgetting the token; misplacing it turns out to be the likelier miss.
 *
 * Still deliberately NOT a bare substring match: "Sue is 11 days old.
 * NOTHING_TO_REPORT otherwise." is a real finding that happens to mention
 * the token mid-sentence, and swallowing a genuine finding is far worse
 * than delivering a quiet one.
 */
const LINE_START_SENTINEL = new RegExp(`^[\\s]*${QUIET_SENTINEL}`, 'm')

export function isQuietScan(replyText: string): boolean {
  return LINE_START_SENTINEL.test(replyText)
}

/**
 * Drops the token and any separator punctuation after it, wherever in the
 * text the model put it. Prose before the token is preserved — it's the
 * model's own summary of the quiet round and reads better than the
 * fallback.
 */
export function stripQuietSentinel(text: string): string {
  const cleaned = text
    .replace(new RegExp(`^[\\s]*${QUIET_SENTINEL}[\\s—:.-]*`, 'm'), '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return cleaned || 'Nothing needed attention this scan.'
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

/**
 * Belt-and-braces: remove the token from operator-facing text regardless of
 * whether the quiet decision fired.
 *
 * The 2026-08-08 leak needed BOTH the detector to miss and the strip to be
 * gated behind that same detector — one check guarding its own cleanup. The
 * sentinel is a protocol detail between the cron and the model and must
 * never render to a human, whatever the classification came out as, so the
 * presentation path no longer depends on the decision path being right.
 */
export function scrubQuietSentinel(text: string): string {
  if (!text.includes(QUIET_SENTINEL)) return text
  return (
    text
      .replace(new RegExp(`^[\\s]*${QUIET_SENTINEL}[\\s—:.-]*`, 'gm'), '')
      .replace(new RegExp(QUIET_SENTINEL, 'g'), '')
      .replace(/\n{3,}/g, '\n\n')
      .trim() || 'Nothing needed attention this scan.'
  )
}
